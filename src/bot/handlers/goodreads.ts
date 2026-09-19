import { Context, Markup } from "telegraf";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "telegraf/types";
import { z } from "zod";
import prisma from "../../lib/prisma.js";
import { generateGoodreadsUrl } from "../../lib/url-utils.js";

const RESPONSE_TTL_MS = 30 * 60 * 1000;

interface DeleteEphemeralMessageParameters {
  chat_id: number;
  receiver_user_id: number;
  ephemeral_message_id: number;
}

interface SendEphemeralMessageParameters {
  chat_id: number;
  text: string;
  ephemeral_message_parameters: { receiver_user_id: number };
  reply_parameters?: { ephemeral_message_id: number };
  message_thread_id?: number;
  reply_markup: InlineKeyboardMarkup;
}

interface EphemeralApi {
  (method: "sendMessage", parameters: SendEphemeralMessageParameters): Promise<unknown>;
  (method: "deleteEphemeralMessage", parameters: DeleteEphemeralMessageParameters): Promise<unknown>;
}

const ephemeralResponseSchema = z.object({
  ephemeral_message_id: z.number().int(),
});

export async function handleGoodreadsCommand(ctx: Context) {
  const message = ctx.message;
  if (!message || !ctx.chat || !ctx.from) return;
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;

  const telegram = ctx.telegram;
  const chatId = ctx.chat.id;
  const receiverUserId = ctx.from.id;
  // Telegraf 4.16 predates Bot API 10.3; callApi forwards these methods unchanged.
  const callEphemeralApi = telegram.callApi.bind(telegram) as unknown as EphemeralApi;

  const requestEphemeralId =
    "ephemeral_message_id" in message && typeof message.ephemeral_message_id === "number"
      ? message.ephemeral_message_id
      : undefined;

  const reply = "reply_to_message" in message ? message.reply_to_message : undefined;
  let text = "Используйте /goodreads в ответ на сохранённую рецензию.";
  const buttons: InlineKeyboardButton.UrlButton[][] = [];

  if (reply) {
    try {
      const reviews = await prisma.review.findMany({
        where: { chatId: BigInt(ctx.chat.id), messageId: BigInt(reply.message_id) },
        include: { book: true },
        orderBy: { id: "asc" },
      });
      const seen = new Set<number>();
      for (const { book } of reviews) {
        if (!book || seen.has(book.id)) continue;
        seen.add(book.id);
        let url = generateGoodreadsUrl(book.isbn, book.title, book.author);
        if (book.goodreadsUrl) {
          try {
            const stored = new URL(book.goodreadsUrl);
            if (
              stored.protocol === "https:" &&
              ["goodreads.com", "www.goodreads.com"].includes(stored.hostname) &&
              !stored.username && !stored.password && !stored.port
            ) {
              url = stored.href;
            }
          } catch {
            // Invalid manually entered URLs fall back to ISBN/title lookup.
          }
        }
        if (url) buttons.push([Markup.button.url(`${book.title} — Goodreads`, url)]);
      }
      text = buttons.length
        ? "Ссылки на Goodreads (ISBN и поиск могут вести к другому изданию):"
        : "Для этого сообщения нет сохранённых рецензий с указанной книгой.";
    } catch (error) {
      console.error("[Goodreads] Failed to find reviewed books:", error);
      text = "Не удалось найти книги. Попробуйте /goodreads позже.";
    }
  }

  try {
    const parameters = {
      chat_id: chatId,
      text: `${ctx.from.first_name}, ${text}\nОтвет удалится через 30 минут.`,
      ephemeral_message_parameters: { receiver_user_id: receiverUserId },
      ...(requestEphemeralId !== undefined
        ? { reply_parameters: { ephemeral_message_id: requestEphemeralId } }
        : {}),
      ...Markup.inlineKeyboard(buttons),
      ...(message.is_topic_message ? { message_thread_id: message.message_thread_id } : {}),
    };
    const sent = ephemeralResponseSchema.parse(await callEphemeralApi("sendMessage", parameters));
    const deletion: DeleteEphemeralMessageParameters = {
      chat_id: chatId,
      receiver_user_id: receiverUserId,
      ephemeral_message_id: sent.ephemeral_message_id,
    };
    // Retain only the API call and identifiers, not the incoming update.
    setTimeout(() => {
      void callEphemeralApi("deleteEphemeralMessage", deletion).catch((error: unknown) => {
        console.warn("[Goodreads] Failed to delete ephemeral response:", error);
      });
    }, RESPONSE_TTL_MS).unref();
  } catch (error) {
    // Do not let global error middleware publish a normal message to the group.
    console.error("[Goodreads] Failed to send ephemeral response:", error);
  } finally {
    // Keep the ephemeral reply target alive until sending finishes. Deletion is
    // best effort and must never prevent delivery or trigger a public error.
    try {
      if (requestEphemeralId !== undefined) {
        await callEphemeralApi("deleteEphemeralMessage", {
          chat_id: chatId,
          receiver_user_id: receiverUserId,
          ephemeral_message_id: requestEphemeralId,
        });
      } else {
        await ctx.deleteMessage();
      }
    } catch (error) {
      console.warn("[Goodreads] Failed to delete command message:", error);
    }
  }
}
