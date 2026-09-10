const fs = require('fs');
const path = require('path');

function parseTokenList(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => String(item || '').split(/\r?\n|,/))
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item, index, array) => array.indexOf(item) === index);
  }

  return String(value || '')
    .split(/\r?\n|,/) 
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index);
}

function addTokenToList(existingTokens, newToken, maxBots = Number.MAX_SAFE_INTEGER) {
  const list = parseTokenList(existingTokens);
  const token = String(newToken || '').trim();

  if (!token) {
    return list;
  }

  if (list.includes(token)) {
    return list;
  }

  if (Number.isFinite(maxBots) && maxBots > 0 && list.length >= maxBots) {
    return list;
  }

  return [...list, token];
}

function persistTokenList(filePath, tokens) {
  const normalized = parseTokenList(tokens);
  const envValue = normalized.join(',');

  const envFilePath = filePath || path.join(process.cwd(), '.env');
  const directory = path.dirname(envFilePath);

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  let existing = '';
  if (fs.existsSync(envFilePath)) {
    existing = fs.readFileSync(envFilePath, 'utf8');
  }

  const lines = existing.split(/\r?\n/);
  let replaced = false;

  const updatedLines = lines.map((line) => {
    if (/^BOT_TOKENS=/i.test(line.trim())) {
      replaced = true;
      return `BOT_TOKENS=${envValue}`;
    }
    return line;
  });

  if (!replaced) {
    updatedLines.push(`BOT_TOKENS=${envValue}`);
  }

  const cleaned = updatedLines.filter((line, index) => {
    if (line.trim() === '') {
      return index === updatedLines.length - 1 ? false : true;
    }
    return true;
  });

  const finalContent = cleaned.join('\n').replace(/\n+$/, '') + '\n';
  fs.writeFileSync(envFilePath, finalContent, 'utf8');
  return envValue;
}

module.exports = {
  parseTokenList,
  addTokenToList,
  persistTokenList,
};
