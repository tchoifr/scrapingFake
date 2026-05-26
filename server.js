const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 9000);
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 250);

const cache = new Map();
const rateLimits = new Map();

const platforms = {
  instagram: {
    label: "Instagram",
    url: (username) => `https://www.instagram.com/${username}/`,
    notFoundPatterns: [
      /page isn't available/i,
      /sorry, this page isn't available/i,
      /the link you followed may be broken/i
    ]
  },
  x: {
    label: "X",
    url: (username) => `https://x.com/${username}`,
    notFoundPatterns: [
      /this account doesn't exist/i,
      /profile not found/i,
      /doesn.?t exist/i
    ]
  },
  tiktok: {
    label: "TikTok",
    url: (username) => `https://www.tiktok.com/@${username}`,
    notFoundPatterns: [
      /couldn.?t find this account/i,
      /account not found/i,
      /user doesn't exist/i
    ]
  },
  youtube: {
    label: "YouTube",
    url: (username) => `https://www.youtube.com/@${username}`,
    notFoundPatterns: [
      /this page isn't available/i,
      /404 not found/i,
      /channel does not exist/i
    ]
  }
};

const platformAliases = {
  twitter: "x",
  xcom: "x",
  tik_tok: "tiktok",
  tik: "tiktok",
  yt: "youtube"
};

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
];

const linkInBioDomains = [
  "linktr.ee",
  "beacons.ai",
  "carrd.co",
  "allmylinks.com",
  "taplink.cc",
  "bio.site",
  "stan.store",
  "hoo.be",
  "solo.to",
  "msha.ke"
];

const ignoredExternalHosts = [
  "about.meta.com",
  "about.instagram.com",
  "help.instagram.com",
  "developers.facebook.com",
  "support.tiktok.com",
  "support.google.com",
  "policies.google.com",
  "www.google.com",
  "accounts.google.com"
];

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static("public"));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePlatform(value) {
  const raw = String(value || "tiktok")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  const normalized = platformAliases[raw] || raw;
  return platforms[normalized] ? normalized : "tiktok";
}

function sanitizeDisplayName(value) {
  return String(value || "")
    .trim()
    .replace(/[\r\n\t<>]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function sanitizeUsername(value) {
  const text = String(value || "").trim();

  if (/^https?:\/\//i.test(text)) {
    const detected = detectSocialLink(text);
    if (detected?.username) {
      return detected.username;
    }
  }

  return text
    .replace(/^@+/, "")
    .replace(/[^\w.-]/g, "")
    .slice(0, 80);
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function getCache(key) {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function setCache(key, value) {
  cache.set(key, {
    createdAt: Date.now(),
    value
  });
}

function isRateLimited(req) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const maxRequests = 30;
  const current = rateLimits.get(ip) || [];
  const recent = current.filter((timestamp) => now - timestamp < windowMs);
  recent.push(now);
  rateLimits.set(ip, recent);
  return recent.length > maxRequests;
}

function buildHeaders() {
  return {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "User-Agent": userAgents[Math.floor(Math.random() * userAgents.length)]
  };
}

async function fetchPage(url) {
  const cacheKey = `page:${url}`;
  const cached = getCache(cacheKey);

  if (cached) {
    return {
      ...cached,
      cached: true
    };
  }

  try {
    const response = await axios.get(url, {
      headers: buildHeaders(),
      maxRedirects: 5,
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true
    });
    const page = {
      url,
      finalUrl: response.request?.res?.responseUrl || url,
      httpStatus: response.status,
      html: typeof response.data === "string" ? response.data : "",
      error: null,
      cached: false
    };

    setCache(cacheKey, page);
    return page;
  } catch (error) {
    const page = {
      url,
      finalUrl: url,
      httpStatus: null,
      html: "",
      error: error.code === "ECONNABORTED"
        ? "Timeout pendant la verification."
        : "Erreur reseau pendant la verification.",
      cached: false
    };

    setCache(cacheKey, page);
    return page;
  }
}

function parseCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (value === null || value === undefined) {
    return null;
  }

  const raw = String(value).trim();
  const match = raw.match(/([\d][\d\s.,]*)([kmb])?/i);

  if (!match) {
    return null;
  }

  const suffix = (match[2] || "").toLowerCase();
  let numberText = match[1].replace(/\s/g, "");

  if (suffix) {
    numberText = numberText.replace(",", ".");
  } else {
    numberText = numberText
      .replace(/[,.](?=\d{3}(\D|$))/g, "")
      .replace(",", ".");
  }

  const parsed = Number(numberText);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const multiplier = suffix === "k"
    ? 1000
    : suffix === "m"
      ? 1000000
      : suffix === "b"
        ? 1000000000
        : 1;

  return Math.round(parsed * multiplier);
}

function formatNumber(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat("fr-FR").format(value) : null;
}

function addIfNumber(target, key, value) {
  const parsed = parseCount(value);
  if (parsed !== null && parsed >= 0) {
    target[key] = Math.max(target[key] || 0, parsed);
  }
}

function mergeStats(...statsList) {
  const merged = {};

  for (const stats of statsList) {
    if (!stats || typeof stats !== "object") {
      continue;
    }

    for (const [key, value] of Object.entries(stats)) {
      addIfNumber(merged, key, value);
    }
  }

  return merged;
}

function extractStatsFromObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const stats = {};

  for (const [key, rawValue] of Object.entries(value)) {
    const lower = key.toLowerCase();

    if ((lower.includes("follower") || lower.includes("fan") || lower.includes("subscriber")) && !lower.includes("following")) {
      addIfNumber(stats, "followers", rawValue);
    }

    if (lower.includes("following") || lower.includes("friendcount")) {
      addIfNumber(stats, "following", rawValue);
    }

    if (lower === "heart" || lower.includes("heartcount") || lower.includes("likecount") || lower === "likes") {
      addIfNumber(stats, "likes", rawValue);
    }

    if (lower.includes("videocount") || lower.includes("awemecount") || lower.includes("postcount") || lower.includes("mediacount")) {
      addIfNumber(stats, "posts", rawValue);
    }
  }

  return stats;
}

function extractCountsFromText(text) {
  const stats = {};
  const patterns = [
    { key: "followers", regex: /([\d][\d\s.,]*)([kmb])?\s*(followers|fans|subscribers)/gi },
    { key: "following", regex: /([\d][\d\s.,]*)([kmb])?\s*(following)/gi },
    { key: "likes", regex: /([\d][\d\s.,]*)([kmb])?\s*(likes|hearts)/gi },
    { key: "posts", regex: /([\d][\d\s.,]*)([kmb])?\s*(videos|posts)/gi }
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      addIfNumber(stats, pattern.key, `${match[1]}${match[2] || ""}`);
    }
  }

  return stats;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }

  return false;
}

function walkJson(value, visitor, depth = 0) {
  if (!value || depth > 45) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkJson(item, visitor, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  visitor(value);

  for (const child of Object.values(value)) {
    walkJson(child, visitor, depth + 1);
  }
}

function extractJsonObjects($) {
  const objects = [];

  $("script").each((_, element) => {
    const raw = ($(element).html() || "").trim();
    if (!raw || raw.length < 2 || raw.length > 3000000) {
      return;
    }

    const firstChar = raw[0];
    if (firstChar !== "{" && firstChar !== "[") {
      return;
    }

    try {
      objects.push(JSON.parse(raw));
    } catch (error) {
      // Some platforms inline regular JS in script tags. Those are ignored.
    }
  });

  return objects;
}

function candidateFromNode(node) {
  const user = node.userInfo?.user || node.user || node.author || node.authorInfo || node.channelMetadataRenderer || node;
  const statsSource = node.userInfo?.stats || node.stats || node.statsV2 || node.authorStats || node;
  const bioLink = user.bioLink || user.bioUrl || user.link || {};
  const username = firstString(
    user.uniqueId,
    user.username,
    user.handle,
    user.vanityChannelUrl?.replace(/^@/, ""),
    user.ownerProfileUrl?.split("/@")[1]
  );
  const displayName = firstString(
    user.nickname,
    user.nickName,
    user.name,
    user.title,
    user.fullName
  );
  const bio = firstString(user.signature, user.bio, user.description, user.shortDescription);
  const avatarUrl = firstString(
    user.avatarLarger,
    user.avatarMedium,
    user.avatarThumb,
    user.avatarUrl,
    user.thumbnail?.thumbnails?.[0]?.url
  );
  const externalUrl = firstString(
    bioLink.link,
    bioLink.url,
    bioLink.href,
    user.website,
    user.url,
    user.externalUrl
  );
  const stats = mergeStats(extractStatsFromObject(statsSource), extractStatsFromObject(user));

  if (!username && !displayName && !bio && !avatarUrl && !externalUrl && Object.keys(stats).length === 0) {
    return null;
  }

  return {
    username,
    displayName,
    bio,
    avatarUrl,
    verified: firstBoolean(user.verified, user.isVerified),
    externalLinks: externalUrl ? [externalUrl] : [],
    stats
  };
}

function extractStructuredProfile(jsonObjects, username) {
  const candidates = [];
  const normalizedUsername = normalizeText(username);

  for (const object of jsonObjects) {
    walkJson(object, (node) => {
      const candidate = candidateFromNode(node);

      if (!candidate) {
        return;
      }

      let score = 0;
      const candidateUsername = normalizeText(candidate.username);

      if (candidateUsername && candidateUsername === normalizedUsername) {
        score += 30;
      } else if (candidateUsername && candidateUsername.includes(normalizedUsername)) {
        score += 12;
      }

      if (candidate.displayName) {
        score += 4;
      }

      if (candidate.bio) {
        score += 4;
      }

      if (Object.keys(candidate.stats).length > 0) {
        score += 8;
      }

      if (candidate.externalLinks.length > 0) {
        score += 4;
      }

      if (score > 0) {
        candidates.push({ ...candidate, score });
      }
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || {
    username: "",
    displayName: "",
    bio: "",
    avatarUrl: "",
    verified: false,
    externalLinks: [],
    stats: {}
  };
}

function extractLatestContentAt(jsonObjects) {
  const timestamps = [];
  const min = Date.UTC(2015, 0, 1) / 1000;
  const max = Date.now() / 1000 + 7 * 24 * 60 * 60;

  for (const object of jsonObjects) {
    walkJson(object, (node) => {
      for (const [key, value] of Object.entries(node)) {
        const lower = key.toLowerCase();
        if (!/(createtime|createdat|publishtime|publishedat|timestamp)$/.test(lower)) {
          continue;
        }

        const number = typeof value === "number" ? value : Number(value);
        const seconds = number > 100000000000 ? Math.floor(number / 1000) : number;

        if (Number.isFinite(seconds) && seconds > min && seconds < max) {
          timestamps.push(seconds);
        }
      }
    });
  }

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps) * 1000).toISOString();
}

function collectEmails(text) {
  return [...new Set(String(text || "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [])];
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch (error) {
    return null;
  }
}

function detectSocialLink(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean);
    const firstSegment = segments[0] || "";

    if (host.endsWith("instagram.com")) {
      if (!firstSegment || ["accounts", "about", "explore", "p", "reel", "stories"].includes(firstSegment)) {
        return null;
      }
      return { platform: "instagram", username: firstSegment.replace(/^@/, ""), url: parsed.toString() };
    }

    if (host === "x.com" || host === "twitter.com" || host.endsWith(".twitter.com")) {
      if (!firstSegment || ["home", "i", "intent", "share", "search"].includes(firstSegment)) {
        return null;
      }
      return { platform: "x", username: firstSegment.replace(/^@/, ""), url: parsed.toString() };
    }

    if (host.endsWith("tiktok.com")) {
      const handle = segments.find((segment) => segment.startsWith("@"));
      if (!handle) {
        return null;
      }
      return { platform: "tiktok", username: handle.replace(/^@/, ""), url: parsed.toString() };
    }

    if (host.endsWith("youtube.com")) {
      const handle = segments.find((segment) => segment.startsWith("@"));
      if (handle) {
        return { platform: "youtube", username: handle.replace(/^@/, ""), url: parsed.toString() };
      }
      if (["channel", "c", "user"].includes(firstSegment) && segments[1]) {
        return { platform: "youtube", username: "", url: parsed.toString() };
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

function hostMatches(url, domains) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch (error) {
    return false;
  }
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }

  return result;
}

function inferDisplayNameFromTitle(title, username) {
  const cleaned = String(title || "")
    .replace(new RegExp(`@?${escapeRegExp(username)}`, "ig"), "")
    .replace(/\s*[-|].*$/, "")
    .replace(/\b(TikTok|Instagram|YouTube|X)\b/gi, "")
    .trim();

  if (!cleaned || cleaned.length < 2 || /^log in$/i.test(cleaned)) {
    return "";
  }

  return cleaned.slice(0, 80);
}

function extractLinks($, baseUrl, structuredLinks = []) {
  const links = [...structuredLinks];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href || href.length > 700) {
      return;
    }

    if (href.startsWith("mailto:")) {
      links.push(href);
      return;
    }

    const url = absoluteUrl(href, baseUrl);
    if (url) {
      links.push(url);
    }
  });

  return [...new Set(links)].slice(0, 80);
}

function extractProfileSignals(html, username, displayName, platform, pageUrl) {
  const $ = cheerio.load(html || "");
  const title = $("title").first().text().trim();
  const description = $('meta[name="description"]').attr("content")
    || $('meta[property="og:description"]').attr("content")
    || "";
  const ogTitle = $('meta[property="og:title"]').attr("content") || "";
  const bodyText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 5000);
  const jsonObjects = extractJsonObjects($);
  const structuredProfile = extractStructuredProfile(jsonObjects, username);
  const latestContentAt = extractLatestContentAt(jsonObjects);
  const links = extractLinks($, pageUrl, structuredProfile.externalLinks);
  const socialLinks = uniqueBy(
    links.map(detectSocialLink).filter(Boolean),
    (link) => `${link.platform}:${link.username || link.url}`
  ).slice(0, 12);
  const externalLinks = links
    .filter((url) => /^https?:\/\//i.test(url))
    .filter((url) => !detectSocialLink(url))
    .filter((url) => !hostMatches(url, ignoredExternalHosts))
    .slice(0, 12);
  const linkInBioLinks = externalLinks.filter((url) => hostMatches(url, linkInBioDomains)).slice(0, 5);
  const joinedText = [
    title,
    description,
    ogTitle,
    bodyText,
    structuredProfile.username,
    structuredProfile.displayName,
    structuredProfile.bio
  ].join(" ");
  const normalizedJoinedText = normalizeText(joinedText);
  const normalizedUsername = normalizeText(username);
  const normalizedName = normalizeText(displayName);
  const usernamePattern = new RegExp(
    `(^|[^a-z0-9._-])@?${escapeRegExp(normalizedUsername)}([^a-z0-9._-]|$)`,
    "i"
  );
  const handleMentioned = usernamePattern.test(normalizedJoinedText)
    || normalizeText(structuredProfile.username) === normalizedUsername;
  const nameMentioned = Boolean(normalizedName && normalizedName.length >= 3 && normalizedJoinedText.includes(normalizedName));
  const emailLinks = links
    .filter((url) => url.startsWith("mailto:"))
    .map((url) => url.replace(/^mailto:/i, "").split("?")[0]);
  const emails = [...new Set([...collectEmails(joinedText), ...emailLinks])].slice(0, 8);
  const stats = mergeStats(extractCountsFromText(joinedText), structuredProfile.stats);
  const meaningfulStats = Boolean(stats.followers || stats.likes || stats.posts);
  const usableLatestContentAt = handleMentioned || meaningfulStats ? latestContentAt : null;
  const latestContentDate = usableLatestContentAt ? new Date(usableLatestContentAt) : null;
  const daysSinceLatestContent = latestContentDate
    ? Math.max(0, Math.round((Date.now() - latestContentDate.getTime()) / (24 * 60 * 60 * 1000)))
    : null;
  const detectedDisplayName = structuredProfile.displayName || inferDisplayNameFromTitle(ogTitle || title, username);

  return {
    title,
    description: description.slice(0, 320),
    handleMentioned,
    nameMentioned,
    emails,
    emailFound: emails.length > 0,
    linkInBioFound: linkInBioLinks.length > 0,
    linkInBioLinks,
    socialLinks,
    externalLinks,
    sampleLinks: links.slice(0, 10),
    profile: {
      username: structuredProfile.username || username,
      displayName: detectedDisplayName,
      bio: (structuredProfile.bio || description).slice(0, 500),
      avatarUrl: structuredProfile.avatarUrl,
      verified: structuredProfile.verified,
      stats,
      latestContentAt: usableLatestContentAt,
      daysSinceLatestContent
    },
    platform
  };
}

function classifySocialPage({ page, username, displayName, platform }) {
  const config = platforms[platform];

  if (page.error) {
    return {
      exists: null,
      confidence: "low",
      status: "error",
      reason: page.error,
      signals: emptySignals(username, platform)
    };
  }

  const signals = extractProfileSignals(page.html, username, displayName, platform, page.finalUrl || page.url);
  const text = [signals.title, signals.description, page.html.slice(0, 8000)].join(" ");
  const blocked = page.httpStatus === 401
    || page.httpStatus === 403
    || page.httpStatus === 429
    || /captcha|rate limit|too many requests|unusual traffic|access denied|verify you are human/i.test(text);
  const notFound = page.httpStatus === 404
    || config.notFoundPatterns.some((pattern) => pattern.test(text));
  const statusOk = page.httpStatus >= 200 && page.httpStatus < 400;
  const weakShell = statusOk
    && !signals.handleMentioned
    && /log in|sign in|connectez-vous|creez un compte|cr.ez un compte|javascript|enable cookies/i.test(text);
  const hasMeaningfulStats = Boolean(
    signals.profile.stats?.followers
    || signals.profile.stats?.likes
    || signals.profile.stats?.posts
  );

  if (notFound) {
    return {
      exists: false,
      confidence: "high",
      status: "not_found",
      reason: "Profil introuvable ou page 404.",
      signals
    };
  }

  if (blocked && signals.handleMentioned && hasMeaningfulStats) {
    return {
      exists: true,
      confidence: "medium",
      status: "found",
      reason: "Donnees publiques recuperees malgre des signaux anti-bot.",
      signals
    };
  }

  if (blocked) {
    return {
      exists: null,
      confidence: "low",
      status: "blocked",
      reason: "Plateforme bloquee, captcha, limite ou acces refuse.",
      signals
    };
  }

  if (statusOk && (signals.handleMentioned || hasMeaningfulStats)) {
    return {
      exists: true,
      confidence: hasMeaningfulStats ? "high" : "medium",
      status: "found",
      reason: hasMeaningfulStats
        ? "Profil accessible avec donnees publiques detectees."
        : "Profil accessible avec mention du pseudo.",
      signals
    };
  }

  if (statusOk && weakShell) {
    return {
      exists: null,
      confidence: "low",
      status: "unknown",
      reason: "Page accessible mais trop peu informative sans navigateur connecte.",
      signals
    };
  }

  if (statusOk) {
    return {
      exists: null,
      confidence: "low",
      status: "unknown",
      reason: "Page accessible mais aucun signe public fiable du profil.",
      signals
    };
  }

  return {
    exists: null,
    confidence: "low",
    status: "error",
    reason: `Reponse HTTP ${page.httpStatus}.`,
    signals
  };
}

function emptySignals(username, platform) {
  return {
    title: "",
    description: "",
    handleMentioned: false,
    nameMentioned: false,
    emails: [],
    emailFound: false,
    linkInBioFound: false,
    linkInBioLinks: [],
    socialLinks: [],
    externalLinks: [],
    sampleLinks: [],
    profile: {
      username,
      displayName: "",
      bio: "",
      avatarUrl: "",
      verified: false,
      stats: {},
      latestContentAt: null,
      daysSinceLatestContent: null
    },
    platform
  };
}

async function checkSocial(platform, username, context = {}, exactUrl = "") {
  const normalizedPlatform = normalizePlatform(platform);
  const config = platforms[normalizedPlatform];
  const safeUsername = sanitizeUsername(username);
  const url = exactUrl || config.url(encodeURIComponent(safeUsername));
  const cacheKey = `social:${normalizedPlatform}:${safeUsername}:${url}:${context.displayName || ""}`;
  const cached = getCache(cacheKey);

  if (cached) {
    return {
      ...cached,
      cached: true
    };
  }

  const page = await fetchPage(url);
  const classified = classifySocialPage({
    page,
    username: safeUsername,
    displayName: context.displayName || "",
    platform: normalizedPlatform
  });
  const result = {
    platform: normalizedPlatform,
    label: config.label,
    url,
    checkedUrl: page.finalUrl || url,
    httpStatus: page.httpStatus,
    checkedAt: new Date().toISOString(),
    cached: page.cached,
    ...classified
  };

  setCache(cacheKey, result);
  return result;
}

function extractExternalSignals(html, baseUrl) {
  const $ = cheerio.load(html || "");
  const title = $("title").first().text().trim();
  const description = $('meta[name="description"]').attr("content")
    || $('meta[property="og:description"]').attr("content")
    || "";
  const bodyText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 5000);
  const links = extractLinks($, baseUrl);
  const socialLinks = uniqueBy(
    links.map(detectSocialLink).filter(Boolean),
    (link) => `${link.platform}:${link.username || link.url}`
  ).slice(0, 12);

  return {
    title,
    description: description.slice(0, 260),
    emails: collectEmails([title, description, bodyText].join(" ")).slice(0, 8),
    socialLinks,
    links: links.filter((url) => /^https?:\/\//i.test(url)).slice(0, 12)
  };
}

async function inspectExternalLinks(links) {
  const candidates = [...new Set(links)]
    .filter((url) => /^https?:\/\//i.test(url))
    .filter((url) => !detectSocialLink(url))
    .filter((url) => !hostMatches(url, ignoredExternalHosts))
    .slice(0, 3);
  const inspections = [];

  for (const url of candidates) {
    const page = await fetchPage(url);
    await sleep(REQUEST_DELAY_MS);

    inspections.push({
      url,
      httpStatus: page.httpStatus,
      status: page.error ? "error" : page.httpStatus >= 200 && page.httpStatus < 400 ? "found" : "unknown",
      reason: page.error || null,
      ...extractExternalSignals(page.html, page.finalUrl || url)
    });
  }

  return inspections;
}

function addFactor(factors, label, points, type = "neutral") {
  factors.push({
    label,
    points,
    type
  });
}

function flattenDiscoveredSocials(primarySocial, externalInspections) {
  return uniqueBy(
    [
      ...(primarySocial.signals?.socialLinks || []),
      ...externalInspections.flatMap((inspection) => inspection.socialLinks || [])
    ],
    (link) => `${link.platform}:${link.username || link.url}`
  );
}

function collectAllEmails(socials, externalInspections) {
  return [...new Set([
    ...Object.values(socials).flatMap((social) => social.signals?.emails || []),
    ...externalInspections.flatMap((inspection) => inspection.emails || [])
  ])].slice(0, 8);
}

function scoreProfile(input, socials, externalInspections, discoveredSocials) {
  const factors = [];
  let score = 0;
  const socialList = Object.values(socials);
  const primary = socials[input.platform];
  const found = socialList.filter((social) => social.exists === true);
  const unknown = socialList.filter((social) => social.exists === null);
  const notFound = socialList.filter((social) => social.exists === false);
  const foundOther = socialList.filter((social) => social.platform !== input.platform && social.exists === true);
  const primaryStats = primary?.signals?.profile?.stats || {};
  const profile = primary?.signals?.profile || emptySignals(input.username, input.platform).profile;
  const emails = collectAllEmails(socials, externalInspections);
  const linkInBioCount = socialList.filter((social) => social.signals?.linkInBioFound).length
    + externalInspections.filter((inspection) => hostMatches(inspection.url, linkInBioDomains)).length;
  const hasStats = Boolean(primaryStats.followers || primaryStats.likes || primaryStats.posts);

  if (primary?.exists === true) {
    score += 25;
    addFactor(factors, `Profil ${platforms[input.platform].label} trouve`, 25, "positive");
  } else if (primary?.exists === false) {
    score -= 25;
    addFactor(factors, `Profil ${platforms[input.platform].label} introuvable`, -25, "negative");
  } else {
    addFactor(factors, `Profil ${platforms[input.platform].label} non confirme automatiquement`, 0, "neutral");
  }

  if (primary?.signals?.handleMentioned) {
    score += 12;
    addFactor(factors, "Pseudo retrouve dans les donnees publiques", 12, "positive");
  }

  if (input.displayName && primary?.signals?.nameMentioned) {
    score += 10;
    addFactor(factors, "Nom du compte coherent avec le profil", 10, "positive");
  } else if (input.displayName && primary?.exists === true && profile.displayName) {
    score -= 5;
    addFactor(factors, "Nom saisi non retrouve clairement", -5, "negative");
  }

  if (hasStats) {
    score += 12;
    addFactor(factors, "Statistiques publiques recuperees automatiquement", 12, "positive");
  }

  if (primaryStats.followers > 0) {
    score += 6;
    addFactor(factors, `${formatNumber(primaryStats.followers)} followers detectes`, 6, "positive");
  }

  if (primaryStats.posts >= 20) {
    score += 10;
    addFactor(factors, "Volume de publications solide", 10, "positive");
  } else if (primaryStats.posts >= 3) {
    score += 5;
    addFactor(factors, "Quelques publications detectees", 5, "positive");
  } else if (primaryStats.followers > 10000 && primaryStats.posts > 0 && primaryStats.posts < 3) {
    score -= 12;
    addFactor(factors, "Beaucoup de followers avec tres peu de contenu", -12, "negative");
  }

  if (primaryStats.followers > 0 && primaryStats.likes > 0) {
    const likeFollowerRatio = primaryStats.likes / primaryStats.followers;

    if (likeFollowerRatio >= 0.2) {
      score += 8;
      addFactor(factors, "Likes globaux coherents avec l'audience", 8, "positive");
    } else if (primaryStats.followers > 50000 && likeFollowerRatio < 0.05) {
      score -= 15;
      addFactor(factors, "Ratio likes/followers suspect", -15, "negative");
    }
  }

  if (profile.daysSinceLatestContent !== null && profile.daysSinceLatestContent <= 45) {
    score += 10;
    addFactor(factors, "Activite recente detectee", 10, "positive");
  } else if (profile.daysSinceLatestContent !== null && profile.daysSinceLatestContent <= 180) {
    score += 5;
    addFactor(factors, "Activite pas trop ancienne", 5, "positive");
  }

  if (emails.length > 0) {
    score += 8;
    addFactor(factors, "Email public detecte", 8, "positive");
  }

  if (linkInBioCount > 0) {
    score += 7;
    addFactor(factors, "Lien bio ou hub externe detecte", 7, "positive");
  }

  if (discoveredSocials.length > 0) {
    score += 8;
    addFactor(factors, "Liens vers d'autres reseaux detectes", 8, "positive");
  }

  if (foundOther.length > 0) {
    const points = Math.min(18, foundOther.length * 9);
    score += points;
    addFactor(factors, `${foundOther.length} autre(s) reseau(x) confirme(s)`, points, "positive");
  }

  if (notFound.length >= 3) {
    score -= 12;
    addFactor(factors, "Pseudo absent de plusieurs plateformes testees", -12, "negative");
  }

  if (unknown.length >= 2) {
    addFactor(factors, "Plusieurs plateformes masquent ou bloquent les donnees", 0, "neutral");
  }

  const finalScore = clamp(Math.round(score), 0, 100);
  let level = "Risque eleve";

  if (finalScore >= 75) {
    level = "Credibilite forte";
  } else if (finalScore >= 50) {
    level = "Credibilite moyenne";
  } else if (finalScore >= 30) {
    level = "A verifier";
  }

  let confidence = 20;
  confidence += primary?.exists === true ? 25 : primary?.exists === false ? 10 : 5;
  confidence += hasStats ? 20 : 0;
  confidence += primary?.signals?.handleMentioned ? 10 : 0;
  confidence += input.displayName && primary?.signals?.nameMentioned ? 8 : 0;
  confidence += Math.min(16, foundOther.length * 8);
  confidence += emails.length > 0 ? 6 : 0;
  confidence -= Math.min(15, unknown.length * 4);

  return {
    username: input.username,
    displayName: input.displayName,
    platform: input.platform,
    score: finalScore,
    level,
    confidence: clamp(Math.round(confidence), 10, 95),
    active: primaryStats.posts >= 3 || (profile.daysSinceLatestContent !== null && profile.daysSinceLatestContent <= 180),
    profile: {
      ...profile,
      emails,
      linkInBioLinks: [...new Set(socialList.flatMap((social) => social.signals?.linkInBioLinks || []))].slice(0, 8),
      externalLinks: [...new Set([
        ...socialList.flatMap((social) => social.signals?.externalLinks || []),
        ...externalInspections.flatMap((inspection) => inspection.links || [])
      ])].slice(0, 12)
    },
    counts: {
      found: found.length,
      unknown: unknown.length,
      notFound: notFound.length,
      discoveredSocials: discoveredSocials.length
    },
    factors
  };
}

function buildRecommendations(scoring, socials, externalInspections) {
  const recommendations = [];
  const primary = socials[scoring.platform];
  const stats = scoring.profile?.stats || {};

  if (primary?.status === "blocked" || primary?.status === "unknown") {
    recommendations.push("Brancher une API TikTok/Instagram/X ou Playwright avec proxy pour confirmer les donnees bloquees.");
  }

  if (Object.keys(stats).length === 0) {
    recommendations.push("Les stats publiques n'ont pas ete exposees par la page. La verification reste partielle.");
  }

  if (!scoring.profile?.emails?.length) {
    recommendations.push("Verifier le contact pro dans la bio, le lien externe ou le media kit.");
  }

  if (externalInspections.some((inspection) => inspection.status === "error")) {
    recommendations.push("Relancer l'analyse plus tard pour les liens externes en erreur.");
  }

  if (scoring.score < 50) {
    recommendations.push("Demander une preuve recente ou un appel video avant collaboration.");
  }

  return recommendations.slice(0, 4);
}

async function analyzeProfile(rawInput) {
  const input = {
    displayName: sanitizeDisplayName(rawInput.displayName || rawInput.name || ""),
    username: sanitizeUsername(rawInput.username || rawInput.handle || ""),
    platform: normalizePlatform(rawInput.platform || rawInput.network || "tiktok")
  };

  if (!input.username) {
    const error = new Error("Pseudo invalide.");
    error.statusCode = 400;
    throw error;
  }

  const primary = await checkSocial(input.platform, input.username, input);
  const externalCandidates = [
    ...(primary.signals?.linkInBioLinks || []),
    ...(primary.signals?.externalLinks || [])
  ];
  const externalInspections = await inspectExternalLinks(externalCandidates);
  const discoveredSocials = flattenDiscoveredSocials(primary, externalInspections);
  const socials = {
    [input.platform]: primary
  };

  for (const platform of Object.keys(platforms)) {
    if (platform === input.platform) {
      continue;
    }

    const discovered = discoveredSocials.find((link) => link.platform === platform);
    const username = discovered?.username || input.username;
    const exactUrl = discovered?.url || "";
    socials[platform] = await checkSocial(platform, username, input, exactUrl);
    await sleep(REQUEST_DELAY_MS);
  }

  const scoring = scoreProfile(input, socials, externalInspections, discoveredSocials);

  return {
    input,
    ...scoring,
    socials,
    discovered: {
      socialLinks: discoveredSocials,
      externalInspections
    },
    recommendations: buildRecommendations(scoring, socials, externalInspections),
    limitations: [
      "Les plateformes peuvent masquer les donnees, retourner une page de connexion ou bloquer l'IP.",
      "Le score est heuristique et doit etre confirme manuellement pour une decision business."
    ]
  };
}

function inputFromRequest(req) {
  return {
    displayName: req.body?.displayName || req.body?.name || req.query.displayName || req.query.name,
    username: req.body?.username || req.body?.handle || req.params.username,
    platform: req.body?.platform || req.body?.network || req.query.platform || req.query.network,
    email: normalizeBoolean(req.query.email)
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    cacheEntries: cache.size,
    platforms: Object.keys(platforms)
  });
});

app.get(["/analyze/:username", "/api/analyze/:username"], async (req, res) => {
  if (isRateLimited(req)) {
    return res.status(429).json({ error: "Trop de requetes, reessaie dans quelques minutes." });
  }

  try {
    const result = await analyzeProfile(inputFromRequest(req));
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Analyse impossible pour le moment."
    });
  }
});

app.post("/api/analyze", async (req, res) => {
  if (isRateLimited(req)) {
    return res.status(429).json({ error: "Trop de requetes, reessaie dans quelques minutes." });
  }

  try {
    const result = await analyzeProfile(inputFromRequest(req));
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Analyse impossible pour le moment."
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Route introuvable." });
});

app.listen(PORT, () => {
  console.log(`Fake Reel Scanner started on http://localhost:${PORT}`);
});
