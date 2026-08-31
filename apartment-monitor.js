#!/usr/bin/env node

/**
 * Apartment Monitor Bot
 * Monitors Van der Linden for new apartments
 * Sends Telegram notifications when new listings appear
 */

const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || '',
  CHECK_INTERVAL_MINUTES: 15,  // Check every 15 minutes
  MAX_PRICE: 1500,
  MIN_SIZE: 45,
  LOCATION: 'Amsterdam',
  EXCLUDE_KEYWORDS: [
    'Seniorenhuisvesting',
    'Ouderenhuisvesting',
    'Studentenhuisvesting',
    'Sociale Huurwoning',
  ],
  DATA_FILE: path.join(__dirname, 'seen-apartments.json'),
};

// Validate token
if (!CONFIG.TELEGRAM_TOKEN) {
  console.error('❌ ERROR: TELEGRAM_TOKEN environment variable is not set!');
  process.exit(1);
}

// Initialize Telegram bot
const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: true });

// Storage for seen apartments
let seenApartments = new Set();

// Load previously seen apartments
function loadSeenApartments() {
  try {
    if (fs.existsSync(CONFIG.DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
      seenApartments = new Set(data.seen || []);
      console.log(`✓ Loaded ${seenApartments.size} previously seen apartments`);
    }
  } catch (err) {
    console.warn('⚠ Could not load seen apartments:', err.message);
  }
}

// Save seen apartments
function saveSeenApartments() {
  try {
    fs.writeFileSync(
      CONFIG.DATA_FILE,
      JSON.stringify({
        seen: Array.from(seenApartments),
        lastUpdated: new Date().toISOString()
      }, null, 2)
    );
  } catch (err) {
    console.warn('⚠ Could not save seen apartments:', err.message);
  }
}

// Fetch apartments from Van der Linden
async function fetchApartments() {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // Set user agent to avoid detection
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto('https://www.vanderlinden.nl/woning-huren/', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Extract apartments
    const apartments = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('[href*="/huurwoning/"]').forEach((link) => {
        const href = link.getAttribute('href');
        if (!href.includes('#')) {
          const parent = link.closest('[href*="/huurwoning/"]')?.parentElement;
          if (parent) {
            const address = parent.textContent.match(/^([^€]*)/)?.[1]?.trim() || '';
            const priceMatch = parent.textContent.match(/€\s*([\d.]+)/);
            const sizeMatch = parent.textContent.match(/(\d+)\s*m²/);
            const price = priceMatch ? parseInt(priceMatch[1].replace(/\./g, '')) : null;
            const size = sizeMatch ? parseInt(sizeMatch[1]) : null;
            const text = parent.textContent;

            if (address && price && size && price > 0 && size > 0) {
              items.push({
                id: href.split('/').filter(Boolean).pop(),
                address,
                price,
                size,
                url: 'https://www.vanderlinden.nl' + href,
                text,
              });
            }
          }
        }
      });
      return items;
    });

    await browser.close();
    return apartments;
  } catch (err) {
    console.error('❌ Error fetching apartments:', err.message);
    if (browser) await browser.close();
    return [];
  }
}

// Filter apartments based on criteria
function filterApartments(apartments) {
  return apartments.filter((apt) => {
    // Already seen this one
    if (seenApartments.has(apt.id)) return false;

    // Price filter
    if (apt.price > CONFIG.MAX_PRICE) return false;

    // Size filter
    if (apt.size < CONFIG.MIN_SIZE) return false;

    // Location filter
    if (!apt.address.includes(CONFIG.LOCATION)) return false;

    // Exclude keywords
    const hasExcludedKeyword = CONFIG.EXCLUDE_KEYWORDS.some(keyword =>
      apt.text.includes(keyword)
    );
    if (hasExcludedKeyword) return false;

    return true;
  });
}

// Send Telegram notification
async function sendNotification(apartment, chatId) {
  const text = `🏠 *New Apartment Found*\n\n` +
    `📍 *Address:* ${apartment.address}\n` +
    `💰 *Price:* €${apartment.price}/month\n` +
    `📐 *Size:* ${apartment.size}m²\n\n` +
    `[View on Van der Linden](${apartment.url})`;

  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    });
    console.log(`📲 Sent notification for: ${apartment.address}`);
  } catch (err) {
    console.error('❌ Failed to send Telegram message:', err.message);
  }
}

// Main check function
async function checkForNewApartments() {
  console.log(`\n🔄 Checking for new apartments at ${new Date().toLocaleTimeString()}...`);

  const apartments = await fetchApartments();
  console.log(`Found ${apartments.length} total apartments on Van der Linden`);

  const newApartments = filterApartments(apartments);
  console.log(`Found ${newApartments.length} new apartments matching your criteria`);

  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!chatId) {
    console.log('⚠ TELEGRAM_CHAT_ID not set yet. Waiting for user message...');
    return;
  }

  // Send notifications for new apartments
  if (newApartments.length > 0) {
    for (const apt of newApartments) {
      await sendNotification(apt, chatId);
      seenApartments.add(apt.id);
      // Delay between messages
      await new Promise(r => setTimeout(r, 500));
    }
    saveSeenApartments();
  } else if (newApartments.length === 0 && apartments.length > 0) {
    console.log('ℹ No new apartments matching your criteria');
  }
}

// Start the bot
async function start() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🤖 Apartment Monitor Bot - Van der Linden');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`⏱️  Checking every ${CONFIG.CHECK_INTERVAL_MINUTES} minutes`);
  console.log(`📍 Location: ${CONFIG.LOCATION}`);
  console.log(`💰 Max price: €${CONFIG.MAX_PRICE}/month`);
  console.log(`📐 Min size: ${CONFIG.MIN_SIZE}m²`);
  console.log('═══════════════════════════════════════════════════════════\n');

  loadSeenApartments();

  // Check immediately on start
  await checkForNewApartments();

  // Check periodically
  setInterval(checkForNewApartments, CONFIG.CHECK_INTERVAL_MINUTES * 60 * 1000);

  // Listen for messages to get Chat ID
  bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    console.log(`✓ Received Chat ID: ${chatId}`);

    if (!process.env.TELEGRAM_CHAT_ID) {
      bot.sendMessage(
        chatId,
        `✅ Chat ID registered: \`${chatId}\`\n\nThe bot is now ready to send you apartment notifications!\n\nYou can set this as a permanent environment variable for future runs.`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  console.log('✓ Bot is running. Waiting for incoming Telegram messages...');
}

// Error handling
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled error:', err);
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  saveSeenApartments();
  process.exit(0);
});

start().catch(console.error);