#!/usr/bin/env node

/**
 * Apartment Monitor Bot - Funda Edition
 * - Van der Linden (✅ working)
 * - Funda.nl (✅ working)
 * - Better user message logging
 */

const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// Configuration
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

  // Add users from TELEGRAM_CHAT_ID env var (explicit backup)
  const envChatIds = process.env.TELEGRAM_CHAT_ID;
  if (envChatIds) {
    const ids = envChatIds.split(',').map(id => id.trim());
    ids.forEach(id => {
      registeredUsers.add(id);
    });
    console.log(`✓ Added ${ids.length} users from TELEGRAM_CHAT_ID env var`);
  }

  console.log(`✓ Loaded ${seenApartments.size} seen apartments`);
  console.log(`✓ Loaded ${registeredUsers.size} registered users: ${Array.from(registeredUsers).join(', ')}`);
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
    console.log('🔍 Fetching Van der Linden...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

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
    console.log(`✓ Van der Linden: Found ${apartments.length} apartments`);
    return apartments;
  } catch (err) {
    console.error('❌ Van der Linden error:', err.message);
    if (browser) await browser.close();
    return [];
  }
}

// Fetch from Funda.nl
async function fetchFundaListings() {
  let browser;
  try {
    console.log('🔍 Fetching Funda.nl...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    await page.goto('https://www.funda.nl/huur/amsterdam/', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    const apartments = await page.evaluate(() => {
      const items = [];
      const seen = new Set();

      // Find all listing links that point to detail pages
      document.querySelectorAll('a[href*="/detail/huur/"]').forEach((link) => {
        const href = link.getAttribute('href');
        if (!href || seen.has(href)) return;
        seen.add(href);

        // Navigate up to find the listing container
        let container = link;
        let depth = 0;
        while (container && depth < 8) {
          const text = container.textContent;
          // Check if this container has both price and size info
          if (text.includes('€') && text.includes('m²')) {
            // Extract price
            const priceMatch = text.match(/€\s*([\d.]+)/);
            let price = null;
            if (priceMatch) {
              price = parseInt(priceMatch[1].replace(/\./g, ''));
            }

            // Extract size
            const sizeMatch = text.match(/(\d+)\s*m²/);
            const size = sizeMatch ? parseInt(sizeMatch[1]) : null;

            // Extract address - usually the first substantial text in the link
            const addressText = link.textContent.trim();
            const address = addressText.split('\n')[0].trim() || 'Unknown';

            if (price && size && price > 0 && size > 0 && address && address !== 'Unknown') {
              items.push({
                id: `funda-${href.split('/').filter(Boolean).pop()}`,
                address,
                price,
                size,
                url: href.startsWith('http') ? href : 'https://www.funda.nl' + href,
                site: 'Funda',
                text,
              });
              return; // Move to next link
            }
          }
          container = container.parentElement;
          depth++;
        }
      });

      return items;
    });

    await browser.close();
    console.log(`✓ Funda.nl: Found ${apartments.length} apartments`);
    return apartments;
  } catch (err) {
    console.error('⚠ Funda.nl error:', err.message);
    if (browser) await browser.close();
    return [];
  }
}

// Filter apartments
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

// Send notification
async function sendNotification(apartment) {
  const text = `🏠 *New Apartment Found* - ${apartment.site}\n\n` +
    `📍 *Address:* ${apartment.address}\n` +
    `💰 *Price:* €${apartment.price}/month\n` +
    `📐 *Size:* ${apartment.size}m²\n\n` +
    `[View Listing](${apartment.url})`;

  console.log(`📤 Sending to ${registeredUsers.size} users: ${apartment.address}`);

  let successCount = 0;
  let failCount = 0;

  for (const chatId of registeredUsers) {
    try {
      await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      });
      console.log(`  ✓ Sent to ${chatId}`);
      successCount++;
    } catch (err) {
      console.error(`  ✗ Failed to send to ${chatId}: ${err.message}`);
      failCount++;
    }
  }

  console.log(`📲 Results: ${successCount} sent, ${failCount} failed`);
}

// ========================================
// TELEGRAM COMMANDS
// ========================================

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`➕ User ${chatId} sent /start`);

  if (!registeredUsers.has(String(chatId))) {
    registeredUsers.add(String(chatId));
    saveData();
    console.log(`✓ Registered new user: ${chatId}`);
    bot.sendMessage(
      chatId,
      '✅ You\'ve been subscribed!\n\nYou will now receive apartment notifications from:\n🏢 Van der Linden\n🏢 Funda.nl\n\nType /help for available commands.'
    );
  } else {
    console.log(`ℹ User ${chatId} already subscribed`);
    bot.sendMessage(chatId, '✅ You\'re already subscribed!');
  }
});

bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`➖ User ${chatId} sent /stop`);

  if (registeredUsers.has(String(chatId))) {
    registeredUsers.delete(String(chatId));
    saveData();
    bot.sendMessage(chatId, '👋 You\'ve been unsubscribed from apartment notifications.');
  }
});

bot.onText(/\/myid/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `🆔 *Your Chat ID:*\n\n\`${chatId}\`\n\nAdd this to Railway's TELEGRAM_CHAT_ID variable!`, { parse_mode: 'Markdown' });
});

bot.onText(/\/debug/, (msg) => {
  const chatId = msg.chat.id;
  const debugInfo = `
📋 *Debug Info*

🆔 Your Chat ID: \`${chatId}\`

👥 Registered Users (${registeredUsers.size}):
${Array.from(registeredUsers).map(u => `  • ${u}`).join('\n')}

🏠 Apartments Tracked: ${seenApartments.size}

📊 Filters:
  Max Price: €${getSettings().maxPrice}
  Min Size: €${getSettings().minSize}m²
  Location: ${getSettings().location}
`;
  bot.sendMessage(chatId, debugInfo, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpText = `
📋 *Available Commands*

/start - Subscribe to notifications
/stop - Unsubscribe
/filter - Show current filter settings
/stats - Show statistics
/setprice <amount> - Set max price
/setsize <amount> - Set min size
/myid - Show your Chat ID
/debug - Show debug information
/help - Show this message
`;
  bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/filter/, (msg) => {
  const chatId = msg.chat.id;
  const current = getSettings();
  const filterText = `
🔍 *Current Filters*

💰 Max Price: €${current.maxPrice}/month
📐 Min Size: ${current.minSize}m²
📍 Location: ${current.location}
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

// ========================================
// MAIN CHECK FUNCTION
// ========================================

async function checkForNewApartments() {
  console.log(`\n🔄 Checking for new apartments at ${new Date().toLocaleTimeString()}...`);

  if (registeredUsers.size === 0) {
    console.log('⚠ No users subscribed yet');
    return;
  }

  console.log(`👥 Sending to ${registeredUsers.size} users: ${Array.from(registeredUsers).join(', ')}`);

  // Fetch from both websites
  const [vdlListings, fundaListings] = await Promise.all([
    fetchVanderLindenListings(),
    fetchFundaListings(),
  ]);

  const allApartments = [...vdlListings, ...fundaListings];
  console.log(`\n📊 Total apartments found: ${allApartments.length}`);

  const newApartments = filterApartments(allApartments);
  console.log(`✓ Apartments matching criteria: ${newApartments.length}\n`);

  if (newApartments.length > 0) {
    for (const apt of newApartments) {
      await sendNotification(apt);
      seenApartments.add(apt.id);
      await new Promise(r => setTimeout(r, 1000));
    }
    saveData();
  }
}

// ========================================
// BOT START
// ========================================

async function start() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🤖 Apartment Monitor Bot - Funda Edition');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🏢 Monitoring Websites:');
  console.log('   • Van der Linden');
  console.log('   • Funda.nl');

  const current = getSettings();
  console.log(`⏱️  Checking every ${current.checkInterval} minutes`);
  console.log(`📍 Location: ${current.location}`);
  console.log(`💰 Max price: €${current.maxPrice}/month`);
  console.log(`📐 Min size: ${current.minSize}m²`);
  console.log('═══════════════════════════════════════════════════════════\n');

  loadData();

  await checkForNewApartments();

  setInterval(checkForNewApartments, getSettings().checkInterval * 60 * 1000);

  console.log('✓ Bot is running and listening for commands...\n');
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
