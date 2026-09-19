import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Telegraf, Telegram } from "telegraf";
import type { Update, Message } from "telegraf/types";
import { z } from "zod";
import { handleGoodreadsCommand } from "../../src/bot/handlers/goodreads.js";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../../src/lib/prisma.js", () => ({ default: { review: { findMany } } }));

const chat = { id: -100123, type: "supergroup" as const, title: "Books" };
const user = { id: 42, is_bot: false, first_name: "Reader" };
const source: Message.TextMessage = { message_id: 10, date: 1, chat, from: user, text: "Review" };
const book = { id: 1, title: "Book", author: "Author", isbn: "978-0747532699", goodreadsUrl: null };
let calls: { method: string; payload: unknown }[];
let failDelete: boolean;

function runCommand(reply = true) {
  const bot = new Telegraf("test-token");
  bot.botInfo = { id: 1, is_bot: true, first_name: "Bot", username: "test_bot", can_join_groups: true,
    can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false,
    has_main_web_app: false };
  bot.command("goodreads", handleGoodreadsCommand);
  const update: Update.MessageUpdate = { update_id: 1, message: {
    message_id: 11, date: 1, chat, from: user, text: "/goodreads@test_bot",
    entities: [{ type: "bot_command", offset: 0, length: 19 }],
    is_topic_message: true, message_thread_id: 5,
    ...(reply ? { reply_to_message: source } : {}),
  } };
  return bot.handleUpdate(update);
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  failDelete = false;
  findMany.mockReset().mockResolvedValue([{ book }]);
  // This transport double handles only the two API methods exercised by the command.
  const callApi = (async (method: string, payload: unknown) => {
    calls.push({ method, payload });
    if (method === "deleteMessage" && failDelete) throw new Error("Forbidden");
    if (method === "sendMessage") return { message_id: 12, date: 1, chat, text: "sent" };
    return true;
  }) as unknown as Telegram["callApi"];
  vi.spyOn(Telegram.prototype, "callApi").mockImplementation(callApi);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

function sent() {
  return z.object({
    chat_id: z.number(), text: z.string(), message_thread_id: z.number().optional(),
    reply_parameters: z.unknown().optional(),
    reply_markup: z.object({ inline_keyboard: z.array(z.array(z.object({ text: z.string(), url: z.string() }))) }),
  }).parse(calls.find((call) => call.method === "sendMessage")?.payload);
}

describe("/goodreads", () => {
  it("deletes the request before lookup, sends in the topic, and expires at exactly 30 minutes", async () => {
    findMany.mockImplementation(async () => {
      expect(calls).toEqual([{ method: "deleteMessage", payload: { chat_id: chat.id, message_id: 11 } }]);
      return [{ book }];
    });
    await runCommand();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { chatId: BigInt(chat.id), messageId: 10n } }));
    expect(sent()).toMatchObject({ chat_id: chat.id, message_thread_id: 5,
      reply_markup: { inline_keyboard: [[{ text: "Book — Goodreads", url: "https://www.goodreads.com/book/isbn/9780747532699" }]] } });
    expect(sent().reply_parameters).toBeUndefined(); // Never reply to the deleted request.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
    expect(calls.filter((call) => call.method === "deleteMessage")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.at(-1)).toEqual({ method: "deleteMessage", payload: { chat_id: chat.id, message_id: 12 } });
  });

  it("prefers a stored Goodreads link, deduplicates books, and includes search for another book", async () => {
    const manual = { ...book, goodreadsUrl: "https://www.goodreads.com/book/show/123" };
    findMany.mockResolvedValue([{ book: manual }, { book: manual }, { book: null },
      { book: { ...book, id: 2, title: "Other & Book", isbn: null } }]);
    await runCommand();
    expect(sent().reply_markup.inline_keyboard.map((row) => row[0].url)).toEqual([
      manual.goodreadsUrl, "https://www.goodreads.com/search?q=Other%20%26%20Book%20Author",
    ]);
  });

  it.each(["garbage", "https://goodreads.com.evil.test/book/1", "http://goodreads.com/book/1", "https://user:password@goodreads.com/book/1"])(
    "falls back from unsafe stored URL %s", async (goodreadsUrl) => {
      findMany.mockResolvedValue([{ book: { ...book, goodreadsUrl } }]);
      await runCommand();
      expect(sent().reply_markup.inline_keyboard[0][0].url).toBe("https://www.goodreads.com/book/isbn/9780747532699");
    });

  it("expires usage guidance without querying the database", async () => {
    await runCommand(false);
    expect(findMany).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(calls.at(-1)).toEqual({ method: "deleteMessage", payload: { chat_id: chat.id, message_id: 12 } });
  });

  it("does not invent a book when the reply is unregistered", async () => {
    findMany.mockResolvedValue([]);
    await runCommand();
    expect(sent().reply_markup.inline_keyboard).toEqual([]);
  });

  it("still responds without deletion permissions and catches delayed deletion failure", async () => {
    failDelete = true;
    await runCommand();
    expect(sent().reply_markup.inline_keyboard[0][0].url).toContain("/book/isbn/");
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("expires database failure responses too", async () => {
    findMany.mockRejectedValue(new Error("Database unavailable"));
    await runCommand();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(calls.at(-1)).toEqual({ method: "deleteMessage", payload: { chat_id: chat.id, message_id: 12 } });
  });
});
