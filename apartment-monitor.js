#!/usr/bin/env node

/**
 * Apartment Monitor Bot - Using Telegraf
 * - Van der Linden (lightweight scraper)
 * - Funda.nl (lightweight scraper)
 * - Uses axios + cheerio instead of Puppeteer
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { Telegraf } = require('telegraf');
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

// HTTP headers
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8',
};

// Validate token
if (!CONFIG.TELEGRAM_TOKEN) {
  console.error('❌ ERROR: TELEGRAM_TOKEN environment variable is not set!');
  process.exit(1);
}

// Initialize Telegraf bot
const bot = new Telegraf(CONFIG.TELEGRAM_TOKEN);

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

async function fetchVanderLindenListings() {
  try {
    console.log('🔍 Fetching Van der Linden...');

    const response = await axios.get('https://www.vanderlinden.nl/woning-huren/', {
      headers: HEADERS,
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);
    const apartments = [];
    const seen = new Set();

    $('[href*="/huurwoning/"]').each((_, element) => {
      const link = $(element);
      const href = link.attr('href');

      if (!href || href.includes('#') || seen.has(href)) return;
      seen.add(href);

      const parent = link.parent();
      const text = parent.text();

      const priceMatch = text.match(/€\s*([\d.]+)/);
      const sizeMatch = text.match(/(\d+)\s*m²/);
      const addressMatch = text.match(/^([^€]+)/);

      if (priceMatch && sizeMatch && addressMatch) {
        const price = parseInt(priceMatch[1].replace(/\./g, ''));
        const size = parseInt(sizeMatch[1]);
        const address = addressMatch[1].trim();

        if (address && price > 0 && size > 0) {
          apartments.push({
            id: `vdl-${href.split('/').filter(Boolean).pop()}`,
            address,
            price,
            size,
            url: href.startsWith('http') ? href : 'https://www.vanderlinden.nl' + href,
            site: 'Van der Linden',
            text,
          });
        }
      }
    });

    console.log(`✓ Van der Linden: Found ${apartments.length} apartments`);
    return apartments;
  } catch (err) {
    console.error('❌ Van der Linden error:', err.message);
    return [];
  }
}

async function fetchFundaListings() {
  try {
    console.log('🔍 Fetching Funda.nl...');

    const response = await axios.get('https://www.funda.nl/huur/amsterdam/', {
      headers: HEADERS,
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);
    const apartments = [];
    const seen = new Set();

    $('a[href*="/detail/huur/"]').each((_, element) => {
      const link = $(element);
      const href = link.attr('href');

      if (!href || seen.has(href)) return;
      seen.add(href);

      let current = link;

      for (let i = 0; i < 8; i++) {
        current = current.parent();
        if (!current.length) break;

        const text = current.text();

        if (text.includes('€') && text.includes('m²')) {
          const priceMatch = text.match(/€\s*([\d.]+)/);
          const sizeMatch = text.match(/(\d+)\s*m²/);
          const addressText = link.text().split('\n')[0].trim();

          if (priceMatch && sizeMatch && addressText) {
            const price = parseInt(priceMatch[1].replace(/\./g, ''));
            const size = parseInt(sizeMatch[1]);

            if (price > 0 && size > 0) {
              apartments.push({
                id: `funda-${href.split('/').filter(Boolean).pop()}`,
                address: addressText,
                price,
                size,
                url: href.startsWith('http') ? href : 'https://www.funda.nl' + href,
                site: 'Funda',
                text,
              });
              break;
            }
          }
        }
      }
    });

    console.log(`✓ Funda.nl: Found ${apartments.length} apartments`);
    return apartments;
  } catch (err) {
    console.error('⚠ Funda.nl error:', err.message);
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
      await bot.telegram.sendMessage(chatId, text, {
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

bot.start((ctx) => {
  const chatId = String(ctx.from.id);
  console.log(`➕ User ${chatId} sent /start`);

  if (!registeredUsers.has(chatId)) {
    registeredUsers.add(chatId);
    saveData();
    console.log(`✓ Registered new user: ${chatId}`);
    ctx.reply('✅ You\'ve been subscribed!\n\nYou will now receive apartment notifications from:\n🏢 Van der Linden\n🏢 Funda.nl\n\nType /help for available commands.');
  } else {
    console.log(`ℹ User ${chatId} already subscribed`);
    ctx.reply('✅ You\'re already subscribed!');
  }
});

bot.command('stop', (ctx) => {
  const chatId = String(ctx.from.id);
  console.log(`➖ User ${chatId} sent /stop`);

  if (registeredUsers.has(chatId)) {
    registeredUsers.delete(chatId);
    saveData();
    ctx.reply('👋 You\'ve been unsubscribed from apartment notifications.');
  }
});

bot.command('myid', (ctx) => {
  const chatId = ctx.from.id;
  ctx.reply(`🆔 *Your Chat ID:*\n\n\`${chatId}\`\n\nAdd this to Railway's TELEGRAM_CHAT_ID variable!`, { parse_mode: 'Markdown' });
});

bot.command('help', (ctx) => {
  const helpText = `/start - Subscribe to notifications
/stop - Unsubscribe
/filter - Show current filter settings
/stats - Show statistics
/setprice <amount> - Set max price
/setsize <amount> - Set min size
/myid - Show your Chat ID
/help - Show this message`;
  ctx.reply(helpText);
});

bot.command('filter', (ctx) => {
  const current = getSettings();
  const filterText = `🔍 *Current Filters*

💰 Max Price: €${current.maxPrice}/month
📐 Min Size: ${current.minSize}m²
📍 Location: ${current.location}`;
  ctx.reply(filterText, { parse_mode: 'Markdown' });
});

bot.command('stats', (ctx) => {
  const statsText = `📊 *Statistics*

👥 Total Users: ${registeredUsers.size}
🏠 Apartments Tracked: ${seenApartments.size}
⏱️ Last Check: ${new Date().toLocaleTimeString()}`;
  ctx.reply(statsText, { parse_mode: 'Markdown' });
});

bot.command('setprice', (ctx) => {
  const args = ctx.message.text.split(' ');
  const price = parseInt(args[1]);

  if (isNaN(price) || price < 100) {
    ctx.reply('❌ Please enter a valid price (minimum €100)');
    return;
  }

  settings.maxPrice = price;
  saveData();
  ctx.reply(`✅ Max price updated to €${price}/month`);
});

bot.command('setsize', (ctx) => {
  const args = ctx.message.text.split(' ');
  const size = parseInt(args[1]);

  if (isNaN(size) || size < 20) {
    ctx.reply('❌ Please enter a valid size (minimum 20m²)');
    return;
  }

  settings.minSize = size;
  saveData();
  ctx.reply(`✅ Min size updated to ${size}m²`);
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
  console.log('🤖 Apartment Monitor Bot - Telegraf Edition');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🏢 Monitoring Websites:');
  console.log('   • Van der Linden');
  console.log('   • Funda.nl');
  console.log('\n⚡ Using lightweight axios + cheerio (no Puppeteer)');

  const current = getSettings();
  console.log(`⏱️  Checking every ${current.checkInterval} minutes`);
  console.log(`📍 Location: ${current.location}`);
  console.log(`💰 Max price: €${current.maxPrice}/month`);
  console.log(`📐 Min size: ${current.minSize}m²`);
  console.log('═══════════════════════════════════════════════════════════\n');

  loadData();

  // Start bot
  bot.launch().catch(err => {
    console.error('⚠ Bot launch error:', err.message);
  });

  // Initial check
  await checkForNewApartments();

  // Regular checks
  setInterval(checkForNewApartments, getSettings().checkInterval * 60 * 1000);

  console.log('✓ Bot is running and listening for commands...\n');

  // Graceful shutdown
  process.once('SIGINT', () => {
    console.log('\n👋 Shutting down gracefully...');
    saveData();
    bot.stop();
    process.exit(0);
  });

  process.once('SIGTERM', () => {
    console.log('\n👋 Shutting down gracefully...');
    saveData();
    bot.stop();
    process.exit(0);
  });
}

start().catch(err => {
  console.error('❌ Startup error:', err);
  process.exit(1);
});
