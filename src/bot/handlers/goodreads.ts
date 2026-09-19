import { Context, Markup } from "telegraf";
import type { InlineKeyboardButton } from "telegraf/types";
import prisma from "../../lib/prisma.js";
import { generateGoodreadsUrl } from "../../lib/url-utils.js";

const RESPONSE_TTL_MS = 30 * 60 * 1000;

export async function handleGoodreadsCommand(ctx: Context) {
  const message = ctx.message;
  if (!message || !ctx.chat || !ctx.from) return;

  try {
    await ctx.deleteMessage();
  } catch (error) {
    console.warn("[Goodreads] Failed to delete command message:", error);
  }

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

  const sent = await ctx.reply(`${ctx.from.first_name}, ${text}\nОтвет удалится через 30 минут.`, {
    ...Markup.inlineKeyboard(buttons),
    ...(message.is_topic_message ? { message_thread_id: message.message_thread_id } : {}),
  });
  // Capture only the API client and message IDs; do not retain the update for 30 minutes.
  const telegram = ctx.telegram;
  const chatId = sent.chat.id;
  const messageId = sent.message_id;
  setTimeout(() => {
    void telegram.deleteMessage(chatId, messageId).catch((error: unknown) => {
      console.warn("[Goodreads] Failed to delete temporary response:", error);
    });
  }, RESPONSE_TTL_MS).unref();
}
