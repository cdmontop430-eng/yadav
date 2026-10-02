const fs = require('fs');
const path = require('path');

const LINE_COMMENT = /^\s*(?:#|\/\/|;)/;

function parseTokenList(value) {
  const lines = Array.isArray(value)
    ? value.flatMap((item) => String(item || '').split(/[\r\n]+/))
    : String(value || '').split(/[\r\n]+/);

  return lines
    .filter((line) => !LINE_COMMENT.test(line))
    .flatMap((line) => line.split(/[,;]+/))
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index);
}

// Token file helpers: one token per line, blank lines and `#` comments ignored.
function readTokenFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }
  return parseTokenList(fs.readFileSync(filePath, 'utf8'));
}

function writeTokenFile(filePath, tokens) {
  const normalized = parseTokenList(tokens);

  if (!filePath) {
    return normalized;
  }

  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const body = normalized.join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
  return normalized;
}

function diffTokenLists(previousTokens, nextTokens) {
  const previous = parseTokenList(previousTokens);
  const next = parseTokenList(nextTokens);

  return {
    added: next.filter((token) => !previous.includes(token)),
    removed: previous.filter((token) => !next.includes(token)),
  };
}

// Adds tokens to the file without touching the ones already in it.
function mergeTokenFile(filePath, incomingTokens) {
  const existing = readTokenFile(filePath);
  const merged = writeTokenFile(filePath, [...existing, ...parseTokenList(incomingTokens)]);
  return { added: merged.length - existing.length, count: merged.length, tokens: merged };
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
  readTokenFile,
  writeTokenFile,
  diffTokenLists,
  mergeTokenFile,
};
