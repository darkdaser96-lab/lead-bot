/**
 * Telegram webhook: /api/bot
 * Env: TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID (never commit secrets)
 * Dialog state is in-memory (fine for a single hobby instance).
 */

const sessions = new Map();

const LEAD_BTN = "Оставить заявку";
const SERVICES = ["Замер", "Ремонт", "Консультация", "Другое"];

function token() {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}

function adminChatId() {
  return process.env.ADMIN_CHAT_ID || "";
}

function webhookPublicUrl() {
  return (
    process.env.WEBHOOK_URL ||
    "https://lead-bot-wine.vercel.app/api/bot"
  );
}

async function tg(method, body) {
  const t = token();
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const res = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const msg =
      (data && data.description) || `Telegram ${method} HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function getSession(chatId) {
  const key = String(chatId);
  if (!sessions.has(key)) {
    sessions.set(key, {
      step: null,
      service: "",
      name: "",
      phone: "",
      comment: "",
    });
  }
  return sessions.get(key);
}

function clearSession(chatId) {
  sessions.delete(String(chatId));
}

async function sendMessage(chatId, text, extra) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

function mainKeyboard() {
  return {
    keyboard: [[{ text: LEAD_BTN }]],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

function serviceKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Замер", callback_data: "svc:Замер" },
        { text: "Ремонт", callback_data: "svc:Ремонт" },
      ],
      [
        { text: "Консультация", callback_data: "svc:Консультация" },
        { text: "Другое", callback_data: "svc:Другое" },
      ],
    ],
  };
}

async function askStart(chatId) {
  const session = getSession(chatId);
  session.step = null;
  session.service = "";
  session.name = "";
  session.phone = "";
  session.comment = "";
  await sendMessage(
    chatId,
    "Здравствуйте! Здесь можно оставить заявку на услугу. Нажмите кнопку «Оставить заявку» внизу экрана.",
    { reply_markup: mainKeyboard() }
  );
}

async function startLead(chatId) {
  const session = getSession(chatId);
  session.step = "service";
  session.service = "";
  session.name = "";
  session.phone = "";
  session.comment = "";
  await sendMessage(chatId, "Какая услуга нужна?", {
    reply_markup: serviceKeyboard(),
  });
}

async function afterServiceChosen(chatId, service) {
  const session = getSession(chatId);
  session.service = service;
  session.step = "name";
  await sendMessage(
    chatId,
    "Услуга: <b>" + escapeHtml(service) + "</b>\nКак вас зовут? Напишите имя.",
    { reply_markup: mainKeyboard() }
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function finishLead(chatId, session, from) {
  const admin = adminChatId();
  const uname = from && from.username ? "@" + from.username : "—";
  const uid = from && from.id != null ? String(from.id) : "—";
  const text =
    "<b>Новая заявка</b>\n" +
    "Услуга: " +
    escapeHtml(session.service || "—") +
    "\n" +
    "Имя: " +
    escapeHtml(session.name) +
    "\n" +
    "Телефон: " +
    escapeHtml(session.phone) +
    "\n" +
    "Комментарий: " +
    escapeHtml(session.comment) +
    "\n" +
    "Telegram: " +
    escapeHtml(uname) +
    " (id " +
    escapeHtml(uid) +
    ")";

  if (!admin) {
    await sendMessage(
      chatId,
      "Заявка сохранена, но ADMIN_CHAT_ID не задан на сервере. Напишите администратору.",
      { reply_markup: mainKeyboard() }
    );
    clearSession(chatId);
    return;
  }

  try {
    await sendMessage(admin, text);
  } catch (err) {
    await sendMessage(
      chatId,
      "Не удалось отправить заявку администратору. Попробуйте позже или напишите нам напрямую.",
      { reply_markup: mainKeyboard() }
    );
    clearSession(chatId);
    return;
  }

  clearSession(chatId);
  await sendMessage(
    chatId,
    "Спасибо! Заявка отправлена. Мы свяжемся с вами.",
    { reply_markup: mainKeyboard() }
  );
  await sendMessage(
    chatId,
    "Если нужна ещё одна заявка — снова нажмите «Оставить заявку» внизу.",
    { reply_markup: mainKeyboard() }
  );
}

async function handleMessage(message) {
  if (!message || !message.chat) return;
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  const session = getSession(chatId);

  if (text === "/start" || text.startsWith("/start ")) {
    await askStart(chatId);
    return;
  }

  if (text === LEAD_BTN) {
    await startLead(chatId);
    return;
  }

  if (text === "/cancel") {
    clearSession(chatId);
    await sendMessage(
      chatId,
      "Заявку отменил. Чтобы начать снова — нажмите «Оставить заявку» внизу.",
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  if (session.step === "service") {
    if (SERVICES.includes(text)) {
      await afterServiceChosen(chatId, text);
      return;
    }
    await sendMessage(chatId, "Выберите услугу кнопкой ниже.", {
      reply_markup: serviceKeyboard(),
    });
    return;
  }

  if (session.step === "name") {
    if (!text) {
      await sendMessage(chatId, "Напишите, пожалуйста, ваше имя.");
      return;
    }
    session.name = text.slice(0, 200);
    session.step = "phone";
    await sendMessage(chatId, "Укажите телефон для связи.");
    return;
  }

  if (session.step === "phone") {
    if (!text) {
      await sendMessage(chatId, "Напишите номер телефона.");
      return;
    }
    session.phone = text.slice(0, 64);
    session.step = "comment";
    await sendMessage(
      chatId,
      "Краткий комментарий к заявке (что нужно / удобное время)."
    );
    return;
  }

  if (session.step === "comment") {
    session.comment = (text || "—").slice(0, 1000);
    session.step = null;
    await finishLead(chatId, session, message.from);
    return;
  }

  await sendMessage(
    chatId,
    "Чтобы оставить заявку, нажмите кнопку «Оставить заявку» внизу экрана.",
    { reply_markup: mainKeyboard() }
  );
}

async function handleCallback(query) {
  if (!query || !query.message) return;
  const chatId = query.message.chat.id;
  const data = query.data || "";
  try {
    await tg("answerCallbackQuery", { callback_query_id: query.id });
  } catch (_) {
    /* ignore */
  }
  if (data === "start_lead") {
    await startLead(chatId);
    return;
  }
  if (data.startsWith("svc:")) {
    const service = data.slice(4);
    if (SERVICES.includes(service)) {
      await afterServiceChosen(chatId, service);
    }
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method === "GET") {
    try {
      if (!token()) {
        return res.status(503).json({
          ok: false,
          error: "TELEGRAM_BOT_TOKEN is not set",
        });
      }
      const url = webhookPublicUrl();
      const result = await tg("setWebhook", {
        url,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      });
      return res.status(200).json({
        ok: true,
        webhook: url,
        telegram: result,
        hasAdmin: Boolean(adminChatId()),
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String((err && err.message) || err),
      });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  if (!token()) {
    return res.status(503).json({ ok: false, error: "no_token" });
  }

  let update = req.body;
  if (typeof update === "string") {
    try {
      update = JSON.parse(update);
    } catch {
      update = {};
    }
  }
  if (!update || typeof update !== "object") update = {};

  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update.message) {
      await handleMessage(update.message);
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("bot error", err);
    return res.status(200).json({
      ok: false,
      error: String((err && err.message) || err),
    });
  }
};
