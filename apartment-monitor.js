#!/usr/bin/env node

/**
 * Apartment Monitor Bot - Enhanced Edition
 * Monitors multiple websites for new apartments:
 * - Van der Linden
 * - Amsterdam Mijndak
 * - IkWillHuren
 */

const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// Configuration from environment variables
const CONFIG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || '',
  CHECK_INTERVAL_MINUTES: parseInt(process.env.CHECK_INTERVAL_MINUTES || '15'),
  MAX_PRICE: parseInt(process.env.MAX_PRICE || '1500'),
  MIN_SIZE: parseInt(process.env.MIN_SIZE || '45'),
  LOCATION: process.env.LOCATION || 'Amsterdam',
  EXCLUDE_KEYWORDS: [
    'Seniorenhuisvesting',
    'Ouderenhuisvesting',
    'Studentenhuisvesting',
    'Sociale Huurwoning',
    'Senior',
    'Student',
  ],
};

// File paths
const SEEN_FILE = path.join(__dirname, 'seen-apartments.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// Validate token
if (!CONFIG.TELEGRAM_TOKEN) {
  console.error('❌ ERROR: TELEGRAM_TOKEN environment variable is not set!');
  process.exit(1);
}

// Initialize Telegram bot
const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: true });

// Storage
let seenApartments = new Set();
let registeredUsers = new Set();
let settings = {};

// Load data files
function loadData() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
      seenApartments = new Set(data.seen || []);
    }
  } catch (err) {
    console.warn('⚠ Could not load seen apartments:', err.message);
  }

  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      registeredUsers = new Set(data.users || []);
    }
  } catch (err) {
    console.warn('⚠ Could not load users:', err.message);
  }

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('⚠ Could not load settings:', err.message);
  }

  // Add users from TELEGRAM_CHAT_ID env var
  const envChatIds = process.env.TELEGRAM_CHAT_ID;
  if (envChatIds) {
    envChatIds.split(',').forEach(id => {
      registeredUsers.add(id.trim());
    });
  }

  console.log(`✓ Loaded ${seenApartments.size} seen apartments`);
  console.log(`✓ Loaded ${registeredUsers.size} registered users`);
}

// Save data files
function saveData() {
  try {
    fs.writeFileSync(
      SEEN_FILE,
      JSON.stringify({
        seen: Array.from(seenApartments),
        lastUpdated: new Date().toISOString()
      }, null, 2)
    );
    fs.writeFileSync(
      USERS_FILE,
      JSON.stringify({
        users: Array.from(registeredUsers),
        lastUpdated: new Date().toISOString()
      }, null, 2)
    );
    fs.writeFileSync(
      SETTINGS_FILE,
      JSON.stringify(settings, null, 2)
    );
  } catch (err) {
    console.warn('⚠ Could not save data:', err.message);
  }
}

// Get current settings
function getSettings() {
  return {
    maxPrice: settings.maxPrice || CONFIG.MAX_PRICE,
    minSize: settings.minSize || CONFIG.MIN_SIZE,
    checkInterval: settings.checkInterval || CONFIG.CHECK_INTERVAL_MINUTES,
    location: settings.location || CONFIG.LOCATION,
  };
}

// ========================================
// WEBSITE SCRAPERS
// ========================================

// Fetch from Van der Linden
async function fetchVanderLindenListings() {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    );

    await page.goto('https://www.vanderlinden.nl/woning-huren/', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

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
                id: `vdl-${href.split('/').filter(Boolean).pop()}`,
                address,
                price,
                size,
                url: 'https://www.vanderlinden.nl' + href,
                site: 'Van der Linden',
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
    console.error('❌ Van der Linden error:', err.message);
    if (browser) await browser.close();
    return [];
  }
}

// Fetch from Mijndak
async function fetchMijndakListings() {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    );

    await page.goto('https://amsterdam.mijndak.nl/WoningOverzicht', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    const apartments = await page.evaluate(() => {
      const items = [];
      const selectors = ['[data-testid*="listing"]', '.woning', '.listing-item', 'a[href*="/woning"]'];

      for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((el) => {
          const link = el.querySelector('a') || el;
          const href = link.getAttribute('href');
          if (href && href.includes('/woning')) {
            const priceMatch = el.textContent.match(/€\s*([\d.]+)/);
            const sizeMatch = el.textContent.match(/(\d+)\s*m²/);
            const price = priceMatch ? parseInt(priceMatch[1].replace(/\./g, '')) : null;
            const size = sizeMatch ? parseInt(sizeMatch[1]) : null;

            if (price && size && price > 0 && size > 0) {
              items.push({
                id: `mijndak-${href.replace(/\//g, '-')}`,
                address: el.textContent.split('\n')[0]?.trim() || 'Unknown',
                price,
                size,
                url: href.startsWith('http') ? href : 'https://amsterdam.mijndak.nl' + href,
                site: 'Mijndak',
                text: el.textContent,
              });
            }
          }
        });
        if (items.length > 0) break;
      }
      return items;
    });

    await browser.close();
    return apartments;
  } catch (err) {
    console.error('⚠ Mijndak error:', err.message);
    if (browser) await browser.close();
    return [];
  }
}

// Fetch from IkWillHuren
async function fetchIkWillHurenListings() {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    );

    await page.goto('https://www.ikwillhuren.nl/', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    const apartments = await page.evaluate(() => {
      const items = [];
      // IkWillHuren typically uses article tags or listing containers
      const selectors = ['article', '.object-item', '.listing', '[data-testid*="listing"]', 'a[href*="woning"]'];

      for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((el) => {
          const link = el.querySelector('a') || el;
          const href = link.getAttribute('href');

          if (href && (href.includes('woning') || href.includes('listing') || href.includes('object'))) {
            const priceMatch = el.textContent.match(/€\s*([\d.,]+)/);
            const sizeMatch = el.textContent.match(/(\d+)\s*m²/);

            let price = null;
            if (priceMatch) {
              const priceStr = priceMatch[1]
                .replace(/\./g, '')
                .replace(/,/g, '.');
              price = parseInt(parseFloat(priceStr));
            }

            const size = sizeMatch ? parseInt(sizeMatch[1]) : null;
            const address = el.textContent.split('\n').find(line => line.trim().length > 5)?.trim() || 'Unknown';

            if (price && size && price > 0 && size > 0 && address) {
              items.push({
                id: `ikwh-${href.replace(/\//g, '-')}`,
                address,
                price,
                size,
                url: href.startsWith('http') ? href : 'https://www.ikwillhuren.nl' + href,
                site: 'IkWillHuren',
                text: el.textContent,
              });
            }
          }
        });
        if (items.length > 0) break;
      }
      return items;
    });

    await browser.close();
    return apartments;
  } catch (err) {
    console.error('⚠ IkWillHuren error:', err.message);
    if (browser) await browser.close();
    return [];
  }
}

// Filter apartments based on current settings
function filterApartments(apartments) {
  const currentSettings = getSettings();

  return apartments.filter((apt) => {
    if (seenApartments.has(apt.id)) return false;
    if (apt.price > currentSettings.maxPrice) return false;
    if (apt.size < currentSettings.minSize) return false;
    if (!apt.address.includes(currentSettings.location)) return false;

    const hasExcludedKeyword = CONFIG.EXCLUDE_KEYWORDS.some(keyword =>
      apt.text.includes(keyword)
    );
    if (hasExcludedKeyword) return false;

    return true;
  });
}

// Send notification to all users
async function sendNotification(apartment) {
  const text = `🏠 *New Apartment Found* - ${apartment.site}\n\n` +
    `📍 *Address:* ${apartment.address}\n` +
    `💰 *Price:* €${apartment.price}/month\n` +
    `📐 *Size:* ${apartment.size}m²\n\n` +
    `[View Listing](${apartment.url})`;

  for (const chatId of registeredUsers) {
    try {
      await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      });
    } catch (err) {
      console.error(`❌ Failed to send to ${chatId}:`, err.message);
    }
  }
  console.log(`📲 Sent notification for: ${apartment.address}`);
}

// ========================================
// TELEGRAM COMMANDS
// ========================================

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!registeredUsers.has(String(chatId))) {
    registeredUsers.add(String(chatId));
    saveData();
    bot.sendMessage(
      chatId,
      '✅ You\'ve been subscribed! You will now receive apartment notifications from:\n\n🏢 Van der Linden\n🏢 Mijndak\n🏢 IkWillHuren\n\nType /help for available commands.'
    );
  } else {
    bot.sendMessage(chatId, '✅ You\'re already subscribed!');
  }
});

bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  if (registeredUsers.has(String(chatId))) {
    registeredUsers.delete(String(chatId));
    saveData();
    bot.sendMessage(chatId, '👋 You\'ve been unsubscribed from apartment notifications.');
  }
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpText = `
📋 *Available Commands*

/start - Subscribe to notifications
/stop - Unsubscribe from notifications
/filter - Show current filter settings
/stats - Show statistics
/setprice <amount> - Set max price (e.g., /setprice 1200)
/setsize <amount> - Set min size (e.g., /setsize 50)
/setcheckinterval <minutes> - Set check frequency (e.g., /setcheckinterval 10)
/websites - Show monitored websites
/help - Show this message

📡 *Monitored Websites:*
🏢 Van der Linden
🏢 Amsterdam Mijndak
🏢 IkWillHuren
`;
  bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/websites/, (msg) => {
  const chatId = msg.chat.id;
  const websitesText = `
🌐 *Monitored Websites*

1️⃣ Van der Linden
   https://www.vanderlinden.nl/woning-huren/

2️⃣ Mijndak
   https://amsterdam.mijndak.nl/WoningOverzicht

3️⃣ IkWillHuren
   https://www.ikwillhuren.nl/

The bot checks all three websites every ${getSettings().checkInterval} minutes and sends notifications for new apartments matching your filters.
`;
  bot.sendMessage(chatId, websitesText, { parse_mode: 'Markdown' });
});

bot.onText(/\/filter/, (msg) => {
  const chatId = msg.chat.id;
  const current = getSettings();
  const filterText = `
🔍 *Current Filters*

💰 Max Price: €${current.maxPrice}/month
📐 Min Size: ${current.minSize}m²
📍 Location: ${current.location}
⏱️ Check Interval: Every ${current.checkInterval} minutes

To change these, use:
/setprice <amount>
/setsize <amount>
/setcheckinterval <minutes>
`;
  bot.sendMessage(chatId, filterText, { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, (msg) => {
  const chatId = msg.chat.id;
  const statsText = `
📊 *Statistics*

👥 Total Users: ${registeredUsers.size}
🏠 Apartments Tracked: ${seenApartments.size}
⏱️ Last Check: ${new Date().toLocaleTimeString()}
`;
  bot.sendMessage(chatId, statsText, { parse_mode: 'Markdown' });
});

bot.onText(/\/setprice (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const price = parseInt(match[1]);

  if (isNaN(price) || price < 100) {
    bot.sendMessage(chatId, '❌ Please enter a valid price (minimum €100)');
    return;
  }

  settings.maxPrice = price;
  saveData();
  bot.sendMessage(chatId, `✅ Max price updated to €${price}/month`);
});

bot.onText(/\/setsize (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const size = parseInt(match[1]);

  if (isNaN(size) || size < 20) {
    bot.sendMessage(chatId, '❌ Please enter a valid size (minimum 20m²)');
    return;
  }

  settings.minSize = size;
  saveData();
  bot.sendMessage(chatId, `✅ Min size updated to ${size}m²`);
});

bot.onText(/\/setcheckinterval (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const interval = parseInt(match[1]);

  if (isNaN(interval) || interval < 5 || interval > 1440) {
    bot.sendMessage(chatId, '❌ Please enter a valid interval (5-1440 minutes)');
    return;
  }

  settings.checkInterval = interval;
  saveData();
  bot.sendMessage(chatId, `✅ Check interval updated to every ${interval} minutes\n\n⚠️ Note: This will take effect on the next deployment.`);
});

// ========================================
// MAIN CHECK FUNCTION
// ========================================

async function checkForNewApartments() {
  if (registeredUsers.size === 0) {
    console.log('⚠ No users subscribed yet');
    return;
  }

  console.log(`\n🔄 Checking for new apartments at ${new Date().toLocaleTimeString()}...`);

  // Fetch from all three websites in parallel
  const [vdlListings, mijndakListings, ikwhListings] = await Promise.all([
    fetchVanderLindenListings(),
    fetchMijndakListings(),
    fetchIkWillHurenListings(),
  ]);

  const allApartments = [...vdlListings, ...mijndakListings, ...ikwhListings];
  console.log(`Found ${allApartments.length} total apartments (VDL: ${vdlListings.length}, Mijndak: ${mijndakListings.length}, IkWH: ${ikwhListings.length})`);

  const newApartments = filterApartments(allApartments);
  console.log(`Found ${newApartments.length} new apartments matching criteria`);

  if (newApartments.length > 0) {
    for (const apt of newApartments) {
      await sendNotification(apt);
      seenApartments.add(apt.id);
      await new Promise(r => setTimeout(r, 500));
    }
    saveData();
  }
}

// ========================================
// BOT START
// ========================================

async function start() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🤖 Apartment Monitor Bot - Enhanced Edition');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🏢 Monitoring Websites:');
  console.log('   • Van der Linden');
  console.log('   • Mijndak');
  console.log('   • IkWillHuren');

  const current = getSettings();
  console.log(`⏱️  Checking every ${current.checkInterval} minutes`);
  console.log(`📍 Location: ${current.location}`);
  console.log(`💰 Max price: €${current.maxPrice}/month`);
  console.log(`📐 Min size: ${current.minSize}m²`);
  console.log('═══════════════════════════════════════════════════════════\n');

  loadData();

  // Check immediately on start
  await checkForNewApartments();

  // Check periodically
  setInterval(checkForNewApartments, getSettings().checkInterval * 60 * 1000);

  console.log('✓ Bot is running and listening for commands...');
}

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled error:', err);
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  saveData();
  process.exit(0);
});

start().catch(console.error);
