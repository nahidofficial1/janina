import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import axios from 'axios';
import winston from 'winston';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { COUNTRY_FLAGS, COUNTRY_NAME_TO_CODE } from './countries.js';



// Telegram Control Panel System (Add / Run / Stop)
// ======================================================================
import TelegramBot from "node-telegram-bot-api";

// 🔐 শুধু এই ID কন্ট্রোল করতে পারবে
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const BOT_TOKEN = process.env.BOT_TOKEN;

// 🔧 ফাইল যেখানে একাউন্ট সংরক্ষণ হবে
const ACCOUNTS_FILE = "accounts.json";
if (!fs.existsSync(ACCOUNTS_FILE)) fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify([]));

// Helper functions
const loadAccounts = () => JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
const saveAccounts = (data) => fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));

// 🔹 Telegram Bot শুরু
const botControl = new TelegramBot(BOT_TOKEN, { polling: true });

// 🔹 মেইন কীবোর্ড
const mainMenu = {
  reply_markup: {
    keyboard: [
      [{ text: "🚀 Run Bot" }, { text: "⏹ Stop Bot" }]
    ],
    resize_keyboard: true,
  },
};

// 🔹 ইনলাইন “Add Account” বাটন
const inlineMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "➕ Add Account", callback_data: "add_account" }]
    ],
  },
};

// ======================================================================
// 🟢 /start কমান্ড
// ======================================================================
botControl.onText(/\/start/, (msg) => {
  if (msg.chat.id !== ADMIN_ID)
    return botControl.sendMessage(msg.chat.id, "⛔ Access denied.");
  
  botControl.sendMessage(
    msg.chat.id,
    "👇 Welcome to your Bot Control Panel:",
    { ...mainMenu, ...inlineMenu }
  );
});

// ======================================================================
// 🟢 /add email password
// ======================================================================
botControl.onText(/\/add (.+) (.+)/, (msg, match) => {
  if (msg.chat.id !== ADMIN_ID)
    return botControl.sendMessage(msg.chat.id, "⛔ Access denied.");

  const chatId = msg.chat.id;
  const email = match[1];
  const password = match[2];

  const accounts = loadAccounts();
  if (accounts.find(a => a.email === email))
    return botControl.sendMessage(chatId, `⚠️ Account already exists: ${email}`);

  accounts.push({ email, password, running: false });
  saveAccounts(accounts);
  botControl.sendMessage(chatId, `✅ Account added successfully:\n📧 ${email}`);
});

// ======================================================================
// 🟢 “Run” / “Stop” বোতাম হ্যান্ডলার
// ======================================================================
botControl.on("message", (msg) => {
  if (msg.chat.id !== ADMIN_ID)
    return botControl.sendMessage(msg.chat.id, "⛔ Access denied.");

  const chatId = msg.chat.id;
  const text = msg.text;
  const accounts = loadAccounts();

  // 🚀 Run Bot
  if (text === "🚀 Run Bot") {
    if (accounts.length === 0)
      return botControl.sendMessage(chatId, "⚠️ No accounts found. Use /add first.");

    const buttons = accounts.map(acc => [{
      text: `🟢 Run: ${acc.email}`,
      callback_data: `run_${acc.email}`,
    }]);
    buttons.push([{ text: "🚀 Run All", callback_data: "run_all" }]);

    botControl.sendMessage(chatId, "👇 Choose an account to run:", {
      reply_markup: { inline_keyboard: buttons },
    });
  }

  // ⏹ Stop Bot
  if (text === "⏹ Stop Bot") {
    const running = accounts.filter(a => a.running);
    if (running.length === 0)
      return botControl.sendMessage(chatId, "⚠️ No bots are running.");

    const buttons = running.map(acc => [{
      text: `⏹ Stop: ${acc.email}`,
      callback_data: `stop_${acc.email}`,
    }]);
    buttons.push([{ text: "🛑 Stop All", callback_data: "stop_all" }]);

    botControl.sendMessage(chatId, "👇 Choose an account to stop:", {
      reply_markup: { inline_keyboard: buttons },
    });
  }
});

// ======================================================================
// 🟢 Inline বাটনের callback handler
// ======================================================================
botControl.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  if (chatId !== ADMIN_ID)
    return botControl.sendMessage(chatId, "⛔ Access denied.");

  const data = query.data;
  const accounts = loadAccounts();

  // ➕ Add Account হেল্প
  if (data === "add_account") {
    botControl.sendMessage(chatId, "✏️ Use this command:\n`/add email password`", {
      parse_mode: "Markdown",
    });
    return;
  }

  // 🚀 Run single bot
  if (data.startsWith("run_")) {
    const email = data.replace("run_", "");
    const acc = accounts.find(a => a.email === email);
    if (!acc) return botControl.sendMessage(chatId, "❌ Account not found!");

    acc.running = true;
    saveAccounts(accounts);

    botControl.sendMessage(chatId, `🕐 Logging in with ${email}...`);

    try {
      // ✅ লগইন কল
      const session = await loginToDashboard(acc.email, acc.password);

      if (session) {
        botControl.sendMessage(chatId, `✅ ${email} logged in successfully! Monitoring started...`);
        logger.info(`✅ ${email} login completed, starting monitoring...`);

        // ✅ কল মনিটরিং শুরু
        await main(session.browser, session.page, session.cookies);
      } else {
        botControl.sendMessage(chatId, `❌ Login failed for ${email}`);
        logger.error(`❌ ${email} login failed, monitoring aborted.`);
      }
    } catch (err) {
      botControl.sendMessage(chatId, `❌ Failed to login for ${email}\nError: ${err.message}`);
      logger.error(`❌ ${email} login error: ${err.message}`);
      acc.running = false;
      saveAccounts(accounts);
    }
  }  // ✅ ← এইটা হলো বন্ধনী “Run Single Bot” এর শেষ

  // 🚀 Run All Bots
  if (data === "run_all") {
    const notRunning = accounts.filter(a => !a.running);
    if (notRunning.length === 0) {
      return botControl.sendMessage(chatId, "⚠️ All bots are already running!");
    }

    for (const acc of notRunning) {
      acc.running = true;
      saveAccounts(accounts);
      botControl.sendMessage(chatId, `🕐 Logging in with ${acc.email}...`);

      try {
        const session = await loginToDashboard(acc.email, acc.password);
        if (session) {
          botControl.sendMessage(chatId, `✅ ${acc.email} logged in successfully!`);
          await main(session.browser, session.page, session.cookies);
        } else {
          botControl.sendMessage(chatId, `❌ Failed to login for ${acc.email}`);
        }
      } catch (err) {
        botControl.sendMessage(chatId, `❌ Error while logging in for ${acc.email}\n${err.message}`);
        logger.error(`❌ ${acc.email} run_all error: ${err.message}`);
        acc.running = false;
      }
    }

    saveAccounts(accounts);
  }

  // ⏹ Stop single bot
  if (data.startsWith("stop_")) {
    const email = data.replace("stop_", "");
    const acc = accounts.find(a => a.email === email);
    if (!acc) return;
    acc.running = false;
    saveAccounts(accounts);

    // 🧠 এখানে চাইলে browser.close() যোগ করতে পারো
    botControl.sendMessage(chatId, `⏹ Monitoring stopped for ${email}.`);
  }

  // ⏹ Stop All Bots
  if (data === "stop_all") {
    const running = accounts.filter(a => a.running);
    for (const acc of running) {
      acc.running = false;
    }
    saveAccounts(accounts);

    // 🧠 এখানে সব browser.close() কল করা যাবে
    botControl.sendMessage(chatId, "✅ All bots stopped!");
  }
});

// ✅ এই দুই লাইন এখানে রাখো
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==============================================================================
// Sensitive Information (loaded from environment variables)
// ==============================================================================
const USERNAME = process.env.USERNAME || "";
const PASSWORD = process.env.PASSWORD || "";


const CHAT_ID = process.env.CHAT_ID || "";

const REFRESH_INTERVAL_MINUTES = 30;
const AUDIO_TRANSCRIPTION_RETRIES = 1;

const MAIN_CHANNEL_NAME = "Main Channel";
const MAIN_CHANNEL_URL = "https://t.me/+75rmPnrS5k9hYThl";

const FRESH_NUMBERS_NAME = "Fresh Numbers";
const FRESH_NUMBERS_URL = "https://t.me/+75rmPnrS5k9hYThl";

const ADMIN_NAME = "BOT DEVELOPER";
const ADMIN_URL = "https://t.me/+75rmPnrS5k9hYThl";

// ✅ ffmpeg initialize
ffmpeg.setFfmpegPath(ffmpegPath);


// ==============================================================================
// Logger
// ==============================================================================
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(info => `${info.timestamp} - ${info.level.toUpperCase()}: ${info.message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'bot_log.txt', level: 'info' })
    ]
});

// ==============================================================================
// Helper functions
// ==============================================================================
const getCountryFlag = (countryName) => {
    const countryNameUpper = countryName.trim().toUpperCase();
    const countryCode = COUNTRY_NAME_TO_CODE[countryNameUpper];
    return COUNTRY_FLAGS[countryCode] || '🌍';
};

// ✅ Mask Number (3 digit + *** + last 4 digit)
const maskNumber = (number) => {
    const numStr = String(number).trim();
    return numStr.length > 7
        ? `${numStr.substring(0, 3)}***${numStr.substring(numStr.length - 4)}`
        : numStr;
};

const extractCountryFromTermination = (text) => {
    const parts = text.split(' ');
    const countryParts = [];
    for (const part of parts) {
        if (['MOBILE', 'FIXED'].includes(part.toUpperCase()) || /\d/.test(part)) {
            break;
        }
        countryParts.push(part);
    }
    return countryParts.length > 0 ? countryParts.join(' ') : text;
};

// ✅ Safe audio sender (parse_mode বাদ দিলাম)
const sendAudioToTelegramGroup = async (caption, filePath) => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`;
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('caption', caption);
    form.append('parse_mode', 'Markdown');
    form.append('audio', fs.createReadStream(filePath));
    try {
        await axios.post(url, form, { headers: form.getHeaders(), timeout: 30000 });
        logger.info("✔️ Audio file sent to Telegram successfully.");
    } catch (e) {
        logger.error(`❌ Failed to send audio file: ${e.response?.data?.description || e.message}`);
    }
};

// ==============================================================================
// Login system
// ==============================================================================
const loginToDashboard = async (email = USERNAME, password = PASSWORD, { headless = false, maxRetries = 2 } = {}) => {
    let browser = null;
    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            browser = await puppeteer.launch({
                headless: headless ? 'new' : false,
                defaultViewport: null,
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-features=IsolateOrigins,site-per-process"
                ]
            });

            const page = await browser.newPage();
            
            // Set a realistic user agent
            await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
            
            // Hide automation indicators
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => false,
                });
            });

            logger.info("🌐 Opening login page...");
            await page.goto("https://www.orangecarrier.com/login", {
                waitUntil: "networkidle2",
                timeout: 60000,
            });

            logger.info("⏳ Waiting 8 sec for page to fully load...");
            await new Promise(r => setTimeout(r, 8000));

            // Try multiple methods to find the login fields
            let emailField = null, passField = null;
            
            // Method 1: Try common selectors first
            try {
                emailField = await page.$('input[type="email"]');
                passField = await page.$('input[type="password"]');
            } catch (e) {
                logger.info("Method 1 failed, trying alternative selectors...");
            }
            
            // Method 2: Scan all inputs
            if (!emailField || !passField) {
                const inputs = await page.$$("input");
                for (const input of inputs) {
                    const attrs = await input.evaluate(el => ({
                        type: el.getAttribute("type"),
                        placeholder: el.getAttribute("placeholder"),
                        name: el.getAttribute("name"),
                        id: el.getAttribute("id"),
                        value: el.value
                    }));

                    if (!emailField && (attrs.type === "email" ||
                        (attrs.placeholder && attrs.placeholder.toLowerCase().includes("email")) ||
                        (attrs.name && attrs.name.toLowerCase().includes("email")) ||
                        (attrs.id && attrs.id.toLowerCase().includes("email")) ||
                        (attrs.name && attrs.name.toLowerCase().includes("user")))) {
                        emailField = input;
                    }
                    if (!passField && attrs.type === "password") {
                        passField = input;
                    }
                }
            }

            if (emailField && passField) {
                logger.info("✅ Email & Password fields detected! Auto filling...");
                await emailField.click();
                await new Promise(r => setTimeout(r, 500));
                await emailField.type(email, { delay: 100 });
                await passField.type(password, { delay: 100 });
                await new Promise(r => setTimeout(r, 500));
                await passField.click();
                await new Promise(r => setTimeout(r, 500));
                await new Promise(r => setTimeout(r, 500));
            } else {
                // Log page content for debugging
                const pageText = await page.evaluate(() => document.body.innerText);
                logger.error(`Page content: ${pageText.substring(0, 500)}`);
                throw new Error("Could not detect email or password field!");
            }

            let loginBtn = await page.$("button[type=submit], input[type=submit]");
            if (!loginBtn) {
                const signInBtns = await page.$x("//button[contains(., 'Sign In')]");
                if (signInBtns.length > 0) loginBtn = signInBtns[0];
            }

            if (loginBtn) {
                logger.info("👉 Clicking Sign In button...");
                await Promise.all([
                    loginBtn.click(),
                    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => null),
                ]);
            } else {
                throw new Error("Sign In button not found!");
            }

            const currentUrl = page.url();
            if (currentUrl.includes("orangecarrier.com")) {
                const pageContent = await page.content();
                if (pageContent.includes("Dashboard") || pageContent.includes("Account Code")) {
                    logger.info("🎉 Login successful! Dashboard detected.");

                    const liveCallsUrl = "https://www.orangecarrier.com/live/calls";
                    await page.goto(liveCallsUrl, { waitUntil: "networkidle2" });
                    const cookies = await page.cookies();

                    return { browser, page, cookies };
                }
            }

            throw new Error("Login failed or dashboard not detected.");
        } catch (err) {
            attempt++;
            logger.error(`❌ Login attempt ${attempt} failed: ${err.message}`);
            if (browser) await browser.close();
            browser = null;
            if (attempt >= maxRetries) return null;
            logger.info("🔄 Retrying login...");
        }
    }
    return null;
};

// ==============================================================================
// Process Call Worker (WAV → MP3 Convert & Send to Telegram)
// ==============================================================================
const processCallWorker = async (callData, cookies, page) => {
    const { country, number, cliNumber, audioUrl, duration = 'Unknown', otp = 'N/A' } = callData;

    try {
        const fileName = `call_${Date.now()}_${cliNumber}.wav`;
        const filePath = path.join(__dirname, fileName);

        const headers = {
            Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
            "User-Agent": "Mozilla/5.0",
        };

        // --- Download audio (WAV) ---
        const response = await axios.get(audioUrl, {
            headers,
            responseType: "arraybuffer",
            timeout: 30000,
        });

        fs.writeFileSync(filePath, Buffer.from(response.data), "binary");
        logger.info(`🎧 Audio file downloaded (WAV): ${fileName}`);
        const filePathMp3 = filePath.replace(".wav", ".mp3");

        // --- WAV → MP3 Convert ---
        await new Promise((resolve, reject) => {
            logger.info("✂️ Trimming audio to maximum 14 seconds...");
            ffmpeg(filePath)
                .audioCodec("libmp3lame")
                .toFormat("mp3")
                .duration(14) // ⏱️ সর্বোচ্চ 14 সেকেন্ড পর্যন্ত অডিও রাখবে
                .on("end", () => {
                    logger.info(`🔄 Converted to MP3 (max 14s): ${path.basename(filePathMp3)}`);
                    resolve();
                })
                .on("error", (err) => {
                    logger.error(`❌ FFmpeg conversion error: ${err.message}`);
                    reject(err);
                })
                .save(filePathMp3);
        });

        // ✅ Custom Caption Format
        const caption = 
`✅ *NEW ${getCountryFlag(country)} ${country.toUpperCase()} CALL RECEIVED 🤖*
━━━━━━━━━━━━━━━━━━━
⏰ *Time:* ${new Date().toLocaleString('en-US', { hour12: true })}
${getCountryFlag(country)} *Country:* ${country.toUpperCase()}
📞 *Number:* ${number}
━━━━━━━━━━━━━━━━━━━`;

        // ✅ Send to Telegram (no buttons)
        await sendAudioToTelegramGroup(caption, filePathMp3);

        // --- Clean up ---
        fs.unlinkSync(filePath);
        fs.unlinkSync(filePathMp3);
        logger.info("🗑️ Temporary files deleted.");
    } catch (e) {
        logger.error(`❌ Error processing call for ${cliNumber}: ${e.message}`);
    }
};

// ==============================================================================
// Main
// ==============================================================================
const main = async (browser, page, cookies) => {
      try {
        const processedCalls = new Set();
        logger.info("🚀 Monitoring started...");

        // keep session alive
        setInterval(async () => {
            logger.info(`🕒 ${REFRESH_INTERVAL_MINUTES} minutes passed. Refreshing page...`);
            try {
                await page.reload({ waitUntil: 'networkidle2' });
                logger.info("✅ Page refreshed successfully.");
            } catch (e) {
                logger.error(`🔴 Page refresh failed: ${e.message}`);
            }
        }, REFRESH_INTERVAL_MINUTES * 60 * 1000);

        // --- Monitoring loop ---
        while (true) {
            try {
                if (page.isClosed()) {
                    logger.error("🔴 Page has been closed. Exiting...");
                    break;
                }

                const pageHtml = await page.evaluate(() => document.documentElement.outerHTML);
                const $ = cheerio.load(pageHtml);

                $('#LiveCalls tr, #last-activity tbody.lastdata tr').each((i, row) => {
                    const columns = $(row).find('td');
                    if (columns.length > 2) {
                        const cliNumber = $(columns[2]).text().trim();
                        const playButton = $(row).find("button[onclick*='Play']");

                        if (playButton.length) {
                            const onclickAttr = playButton.attr('onclick');
                            const matches = onclickAttr.match(/Play\(['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\)/);
                            if (matches) {
                                const [, did, uuid] = matches;
                                const callId = `${cliNumber}_${uuid}`;

                                if (!processedCalls.has(callId)) {
                                    processedCalls.add(callId);

                                    const callData = {
                                        country: extractCountryFromTermination($(columns[0]).text().trim()),
                                        number: $(columns[1]).text().trim(),
                                        cliNumber: cliNumber,
                                        audioUrl: `https://www.orangecarrier.com/live/calls/sound?did=${did}&uuid=${uuid}`
                                    };

                                    logger.info(`📞 New call detected (${cliNumber}), scheduling playback after 14s...`);

                                    // --- Send "waiting" message ---
                                    const waitingMsg = {
                                        chat_id: CHAT_ID,
                                        text: `☎️ New call detected from ${maskNumber(cliNumber)}. Waiting for the call to end.`,
                                    };
                                    let waitingMessageId = null;

                                    axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, waitingMsg)
                                        .then(res => {
                                            waitingMessageId = res.data.result.message_id;
                                            logger.info(`💬 Waiting message sent for ${cliNumber}`);
                                        })
                                        .catch(err => {
                                            logger.error(`❌ Failed to send waiting message: ${err.message}`);
                                        });

                                    // --- Process after 20s ---
                                    setTimeout(async () => {
                                        try {
                                            await processCallWorker(callData, cookies, page);

                                            // Delete the waiting message
                                            if (waitingMessageId) {
                                                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
                                                    chat_id: CHAT_ID,
                                                    message_id: waitingMessageId
                                                });
                                                logger.info(`🗑️ Waiting message deleted for ${cliNumber}`);
                                            }
                                        } catch (err) {
                                            logger.error(`❌ Call processing failed for ${cliNumber}: ${err.message}`);
                                        }
                                    }, 14000);
                                }
                            }
                        }
                    }
                });

            } catch (e) {
                logger.error(`🔴 Unexpected error in monitoring loop: ${e.message}`);

                if (
                    e.message.includes('detached') ||
                    e.message.includes('Target closed') ||
                    e.message.includes('Execution context was destroyed')
                ) {
                    logger.info("⚠️ Page issue detected, attempting to recover...");

                    try {
                        // ✅ যদি ব্রাউজার বন্ধ থাকে তাহলে পুরো re-login
                        if (!browser || !browser.isConnected()) {
                            logger.warn("🔴 Browser disconnected — attempting full re-login...");
                            const newSession = await loginToDashboard({ headless: true, maxRetries: 1 });
                            if (!newSession) throw new Error("Full re-login failed");
                            browser = newSession.browser;
                            page = newSession.page;
                            cookies = newSession.cookies;
                            logger.info("✅ Re-login successful! Monitoring resumed.");
                            await new Promise(r => setTimeout(r, 3000));
                        } else {
                            // ✅ পুরনো পেজ বন্ধ করো
                            try {
                                if (page && !page.isClosed()) {
                                    await page.close();
                                    logger.info("🗑️ Closed old detached page.");
                                }
                            } catch (closeErr) {
                                logger.warn(`⚠️ Error closing old page: ${closeErr.message}`);
                            }

                            // ✅ নতুন পেজ খুলে লগইন URL এ যাও
                            const newPage = await browser.newPage();
                            await newPage.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
                            await newPage.goto("https://www.orangecarrier.com/live/calls", {
                                waitUntil: "domcontentloaded",
                                timeout: 60000
                            });
                            page = newPage;
                            logger.info("✅ Page recovered successfully with new session.");
                            await new Promise(r => setTimeout(r, 3000));
                        }
                    } catch (recoverErr) {
                        logger.error(`🔴 Failed to recover page: ${recoverErr.message}`);
                        logger.info("🔄 Will retry monitoring after delay...");
                        await new Promise(r => setTimeout(r, 10000));
                    }
                } else {
                    await new Promise(r => setTimeout(r, 5000));
                }
            }

            await new Promise(resolve => setTimeout(resolve, 100));
        }

    } catch (e) {
        logger.error(`🔴 Browser or driver crashed! Error: ${e.message}`);
    } finally {
        if (browser) {
            logger.info("Stopping the bot.");
            await browser.close();
        }
    }
};


// ==============================================================================
// 🟢 Keep Alive Server (Render/Replit এ বট জেগে রাখবে)
// ==============================================================================
import http from "http";

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.end("✅ Bot is alive!");
}).listen(port, () => console.log(`🌍 Keep-alive server running on port ${port}`));

// প্রতি ৫ মিনিটে নিজের লিংক পিং করবে (Render/Replit এর জন্য)
setInterval(() => {
  fetch("https://fruitful-slategrey-databases-lavisa2737.replit.app").catch(() => {});
}, 5 * 60 * 1000);