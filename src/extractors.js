function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PROVIDER_PATHS = [
  "provider_name",
  "providerName",
  "provider",
  "supplier_name",
  "supplierName",
  "supplier",
  "vendorName",
  "vendor",
  "companyName",
  "company",
  "partnerName",
  "partner",
  "provider.name",
  "supplier.name",
  "vendor.name",
  "company.name",
  "partner.name",
  "rentalCompany.name",
  "rental_company.name"
];

const CAR_NAME_PATHS = [
  "car_name",
  "carName",
  "vehicleName",
  "modelName",
  "vehicle.name",
  "car.name",
  "model.name",
  "title"
];

const CAR_CLASS_PATHS = [
  "car_class",
  "carClass",
  "vehicleClass",
  "className",
  "acriss",
  "vehicle.class",
  "car.class",
  "category"
];

const TRANSMISSION_PATHS = [
  "transmission",
  "transmissionType",
  "transmission_type",
  "gearbox",
  "gearboxType",
  "gearbox_type",
  "vehicle.transmission",
  "vehicle.transmissionType",
  "vehicle.gearbox",
  "car.transmission",
  "car.transmissionType",
  "car.gearbox",
  "specs.transmission",
  "specifications.transmission",
  "features.transmission",
  "details.transmission",
  "acriss",
  "car.acriss",
  "vehicle.acriss"
];

const RATING_PATHS = [
  "provider_rating",
  "providerRating",
  "supplier_rating",
  "supplierRating",
  "vendorRating",
  "companyRating",
  "partnerRating",
  "rating",
  "score",
  "reviewScore",
  "review_score",
  "customerRating",
  "customerScore",
  "provider.rating",
  "provider.score",
  "supplier.rating",
  "supplier.score",
  "supplier.reviewScore",
  "vendor.rating",
  "company.rating",
  "partner.rating",
  "rentalCompany.rating",
  "reviews.rating",
  "reviews.score",
  "reviews.average",
  "review.rating",
  "review.score",
  "rating.value",
  "rating.score",
  "rating.average"
];

const PRICE_PATHS = [
  "total_price",
  "totalPrice",
  "fullPrice",
  "amount",
  "formattedPrice",
  "total",
  "price",
  "pricing.total",
  "pricing.amount",
  "pricing.price",
  "pricing.payNow",
  "pricing.payOnArrival",
  "price.total",
  "price.amount",
  "price.formatted",
  "price.display",
  "price.value",
  "prices.total",
  "prices.default",
  "prices.lowest",
  "payment.total",
  "payment.amount",
  "payment.payNow",
  "payment.payOnArrival",
  "amount_total"
];

const CURRENCY_SYMBOLS = {
  zl: "PLN",
  PLN: "PLN",
  "\u20ac": "EUR",
  EUR: "EUR",
  "$": "USD",
  USD: "USD",
  "\u00a3": "GBP",
  GBP: "GBP"
};

function getByPath(value, path) {
  const parts = String(path).split(".");
  let cursor = value;

  for (const part of parts) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    cursor = cursor[part];
  }

  return cursor;
}

function firstStringByPaths(candidate, paths) {
  for (const path of paths) {
    const raw = getByPath(candidate, path);
    if (typeof raw === "string" && normalizeWhitespace(raw)) {
      return normalizeWhitespace(raw);
    }
  }

  return "";
}

function normalizeTransmission(value) {
  const compactCode = normalizeWhitespace(value).toUpperCase().replace(/[^A-Z]/g, "");
  if (/^[A-Z]{4}$/.test(compactCode)) {
    if (compactCode[2] === "A") {
      return "automatic";
    }
    if (compactCode[2] === "M") {
      return "manual";
    }
  }

  const text = normalizeWhitespace(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!text) {
    return "";
  }

  if (/\b(automatic|automat|automatyczna|auto|a\/t|at)\b/.test(text)) {
    return "automatic";
  }
  if (/\b(manual|manualna|reczna|m\/t|mt|stick shift|stick)\b/.test(text)) {
    return "manual";
  }

  return "";
}

function normalizeTransmissionFilter(value) {
  const normalized = normalizeTransmission(value);
  if (normalized) {
    return normalized;
  }

  const text = normalizeWhitespace(value).toLowerCase();
  if (text === "all" || text === "any" || text === "none" || text === "off") {
    return "";
  }

  return "";
}

function findTransmissionInCandidate(candidate, maxDepth = 4) {
  if (!candidate || typeof candidate !== "object") {
    return "";
  }

  for (const path of TRANSMISSION_PATHS) {
    const transmission = normalizeTransmission(getByPath(candidate, path));
    if (transmission) {
      return transmission;
    }
  }

  const visited = new Set();
  const stack = [{ value: candidate, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (!value || typeof value !== "object" || visited.has(value) || depth > maxDepth) {
      continue;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          const transmission = normalizeTransmission(item);
          if (transmission) {
            return transmission;
          }
        } else if (item && typeof item === "object") {
          stack.push({ value: item, depth: depth + 1 });
        }
      }
      continue;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      if (/transmission|gearbox|gear|acriss/i.test(key)) {
        const transmission = normalizeTransmission(nestedValue);
        if (transmission) {
          return transmission;
        }
      }
      if (nestedValue && typeof nestedValue === "object") {
        stack.push({ value: nestedValue, depth: depth + 1 });
      }
    }
  }

  return "";
}

function filterOffersByTransmission(offers, transmissionFilter = "") {
  const normalizedFilter = normalizeTransmissionFilter(transmissionFilter);
  if (!normalizedFilter) {
    return Array.isArray(offers) ? offers : [];
  }

  return (Array.isArray(offers) ? offers : []).filter(
    (offer) => normalizeTransmission(offer?.transmission) === normalizedFilter
  );
}

function normalizeRatingValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10) {
    return null;
  }

  return Number(parsed.toFixed(1));
}

function parseRatingValue(rawValue) {
  if (rawValue == null) {
    return null;
  }

  if (typeof rawValue === "number") {
    return normalizeRatingValue(rawValue);
  }

  if (typeof rawValue === "string") {
    const normalized = normalizeWhitespace(rawValue).replace(",", ".");
    const matches = normalized.match(/\d+(?:\.\d+)?/g) || [];
    for (const match of matches) {
      const rating = normalizeRatingValue(match);
      if (rating != null) {
        return rating;
      }
    }
    return null;
  }

  if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
    const preferredKeys = [
      "rating",
      "score",
      "value",
      "average",
      "averageScore",
      "reviewScore",
      "supplierRating",
      "providerRating"
    ];

    for (const key of preferredKeys) {
      const rating = parseRatingValue(rawValue[key]);
      if (rating != null) {
        return rating;
      }
    }

    for (const [key, value] of Object.entries(rawValue)) {
      if (!/rating|score|review/i.test(key)) {
        continue;
      }
      const rating = parseRatingValue(value);
      if (rating != null) {
        return rating;
      }
    }
  }

  return null;
}

function firstRatingByPaths(candidate, paths) {
  for (const path of paths) {
    const raw = getByPath(candidate, path);
    const rating = parseRatingValue(raw);
    if (rating != null) {
      return rating;
    }
  }

  return null;
}

function normalizeCurrencyCode(rawCurrency, fallback = "") {
  const text = normalizeWhitespace(rawCurrency).toUpperCase();
  if (!text) {
    return normalizeWhitespace(fallback).toUpperCase();
  }

  if (text in CURRENCY_SYMBOLS) {
    return CURRENCY_SYMBOLS[text];
  }

  if (/^[A-Z]{3}$/.test(text)) {
    return text;
  }

  return normalizeWhitespace(fallback).toUpperCase();
}

function detectCurrency(rawText, fallbackCurrency = "") {
  const text = normalizeWhitespace(rawText);
  if (!text) {
    return normalizeCurrencyCode("", fallbackCurrency);
  }

  const codeMatch = text.match(/\b([A-Z]{3})\b/);
  if (codeMatch?.[1]) {
    return normalizeCurrencyCode(codeMatch[1], fallbackCurrency);
  }

  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (text.includes(symbol)) {
      return code;
    }
  }

  return normalizeCurrencyCode("", fallbackCurrency);
}

function extractNumericCandidate(rawText) {
  const matches = String(rawText).match(/-?\d[\d\s.,]*/g) || [];
  const filtered = matches
    .map((item) => normalizeWhitespace(item))
    .filter((item) => /\d/.test(item));

  if (!filtered.length) {
    return "";
  }

  filtered.sort((left, right) => {
    const leftDigits = left.replace(/[^\d]/g, "").length;
    const rightDigits = right.replace(/[^\d]/g, "").length;
    if (leftDigits !== rightDigits) {
      return rightDigits - leftDigits;
    }
    return right.length - left.length;
  });

  return filtered[0];
}

function normalizeNumberString(rawNumeric) {
  let numeric = String(rawNumeric || "")
    .replace(/\s+/g, "")
    .replace(/[^\d,.-]/g, "");

  if (!numeric) {
    return "";
  }

  const lastComma = numeric.lastIndexOf(",");
  const lastDot = numeric.lastIndexOf(".");

  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      numeric = numeric.replace(/\./g, "").replace(",", ".");
    } else {
      numeric = numeric.replace(/,/g, "");
    }
    return numeric;
  }

  if (lastComma !== -1) {
    const fractionLength = numeric.length - lastComma - 1;
    if (fractionLength > 0 && fractionLength <= 2) {
      return numeric.replace(/\./g, "").replace(",", ".");
    }
    return numeric.replace(/,/g, "");
  }

  if (lastDot !== -1) {
    const fractionLength = numeric.length - lastDot - 1;
    if (fractionLength > 0 && fractionLength <= 2) {
      return numeric;
    }
    return numeric.replace(/\./g, "");
  }

  return numeric;
}

function parsePriceToNumber(rawValue, fallbackCurrency = "") {
  if (rawValue == null) {
    return null;
  }

  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return {
      value: rawValue,
      currency: normalizeCurrencyCode("", fallbackCurrency)
    };
  }

  const text = normalizeWhitespace(String(rawValue));
  if (!text) {
    return null;
  }

  const currency = detectCurrency(text, fallbackCurrency);
  const numericCandidate = extractNumericCandidate(text);
  if (!numericCandidate) {
    return null;
  }

  const normalizedNumeric = normalizeNumberString(numericCandidate);
  const value = Number.parseFloat(normalizedNumeric);
  if (!Number.isFinite(value)) {
    return null;
  }

  return {
    value,
    currency
  };
}

function extractPriceCandidate(candidate, fallbackCurrency = "") {
  for (const path of PRICE_PATHS) {
    const raw = getByPath(candidate, path);
    const parsed = parsePriceToNumber(raw, fallbackCurrency);
    if (parsed) {
      return parsed;
    }
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  for (const [key, value] of Object.entries(candidate)) {
    if (!/price|total|amount|pay/i.test(key)) {
      continue;
    }

    const parsedDirect = parsePriceToNumber(value, fallbackCurrency);
    if (parsedDirect) {
      return parsedDirect;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const nestedValue of Object.values(value)) {
        const parsedNested = parsePriceToNumber(nestedValue, fallbackCurrency);
        if (parsedNested) {
          return parsedNested;
        }
      }
    }
  }

  return null;
}

function normalizeOfferCandidate(candidate, context) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const providerName = firstStringByPaths(candidate, PROVIDER_PATHS);
  if (!providerName) {
    return null;
  }

  const price = extractPriceCandidate(candidate, context.currency || "");
  if (!price) {
    return null;
  }

  const preferredCarName = firstStringByPaths(candidate, CAR_NAME_PATHS);
  const fallbackCarClass = firstStringByPaths(candidate, CAR_CLASS_PATHS);
  const carName = preferredCarName || fallbackCarClass || null;
  const providerRating = firstRatingByPaths(candidate, RATING_PATHS);
  const transmission = findTransmissionInCandidate(candidate);

  return {
    location: context.location,
    provider_name: providerName,
    provider_rating: providerRating,
    total_price: price.value,
    currency: normalizeCurrencyCode(price.currency, context.currency || ""),
    pickup_date: context.pickup_date,
    dropoff_date: context.dropoff_date,
    rental_days: context.rental_days,
    car_name: carName,
    transmission: transmission || null,
    source_url: context.source_url
  };
}

function dedupeOffers(offers) {
  const seen = new Set();
  const unique = [];

  for (const offer of offers) {
    if (!offer || !Number.isFinite(offer.total_price)) {
      continue;
    }

    const providerKey = normalizeWhitespace(offer.provider_name).toLowerCase();
    if (!providerKey) {
      continue;
    }

    const key = [
      normalizeWhitespace(offer.location).toLowerCase(),
      providerKey,
      offer.total_price.toFixed(2),
      normalizeWhitespace(offer.currency).toUpperCase(),
      normalizeWhitespace(offer.car_name || "").toLowerCase()
    ].join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push({
      ...offer,
      provider_name: normalizeWhitespace(offer.provider_name),
      provider_rating: Number.isFinite(offer.provider_rating) ? Number(offer.provider_rating) : null,
      car_name: offer.car_name ? normalizeWhitespace(offer.car_name) : null
    });
  }

  return unique;
}

function sortOffersByPrice(offers) {
  return [...offers].sort((left, right) => left.total_price - right.total_price);
}

function chooseCheapestOffer(offers) {
  const sorted = sortOffersByPrice(offers);
  return sorted[0] || null;
}

function extractOffersFromPayload(payload, context) {
  const offers = [];
  const visited = new Set();
  const stack = [payload];

  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const normalized = normalizeOfferCandidate(current, context);
    if (normalized) {
      offers.push(normalized);
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        if (item && typeof item === "object") {
          stack.push(item);
        }
      }
      continue;
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  return sortOffersByPrice(dedupeOffers(offers));
}

async function extractOffersFromDom(page, context) {
  const rawCards = await page.evaluate((options) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const transmissionFilter = normalize(options.transmissionFilter || "").toLowerCase();
    const includeSupplierRows = transmissionFilter !== "automatic";

    const output = [];

    const parseRating = (value) => {
      const text = normalize(value).replace(",", ".");
      const matches = text.match(/\d+(?:\.\d+)?/g) || [];
      for (const match of matches) {
        const rating = Number.parseFloat(match);
        if (Number.isFinite(rating) && rating > 0 && rating <= 10) {
          return Number(rating.toFixed(1));
        }
      }
      return null;
    };

    const findRatingText = (root) => {
      const ratingSelectors = [
        ".SupplierInfo-RatingScore",
        "[class*='RatingScore']",
        "[class*='SupplierScore']",
        "[data-testid*='rating']",
        "[data-testid*='score']",
        "[class*='rating']",
        "[class*='score']",
        "[aria-label*='rating' i]",
        "[aria-label*='score' i]"
      ];

      for (const selector of ratingSelectors) {
        const element = root.querySelector(selector);
        const text = normalize(element?.textContent || element?.getAttribute?.("aria-label") || "");
        if (parseRating(text) != null) {
          return text;
        }
      }

      const lines = normalize(root.textContent).split(/\n+/).map(normalize).filter(Boolean);
      return lines.find((line) => /(rating|score|excellent|very good|good)/i.test(line) && parseRating(line) != null) || "";
    };

    const detectTransmission = (text) => {
      const normalized = normalize(text).toLowerCase();
      const hasAutomatic = /\b(automatic transmission|automatic|automat)\b/.test(normalized);
      const hasManual = /\b(manual transmission|manual)\b/.test(normalized);
      if (hasAutomatic && !hasManual) {
        return "automatic";
      }
      if (hasManual && !hasAutomatic) {
        return "manual";
      }
      return "";
    };

    const addCandidate = (providerName, priceText, carName = null, ratingText = "", transmissionText = "") => {
      const provider = normalize(providerName);
      const price = normalize(priceText);
      const car = normalize(carName || "");
      const rating = parseRating(ratingText);
      const transmission = detectTransmission(transmissionText || car);

      if (!provider || !price || !/\d/.test(price)) {
        return;
      }

      output.push({
        provider_name: provider,
        provider_rating: rating,
        price_text: price,
        car_name: car || null,
        transmission: transmission || null
      });
    };

    // Supplier filter section often contains min-price per provider and is usually stable.
    const supplierRows = includeSupplierRows
      ? Array.from(
          document.querySelectorAll(
            ".SearchFiltersGroup-FilterWrapper, [class*='SearchFiltersGroup-FilterWrapper'], [class*='supplier'] [class*='filter']"
          )
        )
      : [];

    for (const row of supplierRows) {
      const provider =
        row.querySelector(".SearchFiltersGroup-FilterLabel, [class*='FilterLabel']")?.textContent || "";
      const price =
        row.querySelector(".SearchFiltersGroup-FilterMinPrice, [class*='FilterMinPrice']")?.textContent || "";
      const rating = findRatingText(row);

      addCandidate(provider, price, null, rating);
    }

    const selectors = [
      ".SearchCar",
      "[class*='SearchCar']",
      "article",
      "[data-testid*='offer']",
      "[data-testid*='result']",
      "[class*='offer']",
      "[class*='result']",
      "[class*='vehicle']",
      "[class*='car']"
    ];

    const cards = Array.from(document.querySelectorAll(selectors.join(",")));

    for (const card of cards.slice(0, 500)) {
      const text = normalize(card.textContent);
      if (!text || !/\d/.test(text)) {
        continue;
      }
      if (!/(price|total|supplier|provider|book|deal|cancellation|rating)/i.test(text)) {
        continue;
      }

      const lines = text.split(/\n+/).map(normalize).filter(Boolean);
      const totalPriceMatch = text.match(
        /total for\s+\d+\s+days?\s+((?:PLN|EUR|USD|GBP|z[l\u0142]|\u20ac|\$|\u00a3)\s*[\d\s.,]+)/i
      );
      const priceLine =
        normalize(totalPriceMatch?.[1] || "") ||
        lines.find((line) => /total for/i.test(line) && /(PLN|EUR|USD|GBP|z[l\u0142]|\u20ac|\$|\u00a3)/i.test(line)) ||
        lines.find((line) => /(PLN|EUR|USD|GBP|z[l\u0142]|\u20ac|\$|\u00a3)/i.test(line) && /\d/.test(line)) ||
        lines.find((line) => /\d/.test(line) && line.length < 36);

      if (!priceLine) {
        continue;
      }

      const carNameElement = card.querySelector(
        ".CarTitle-Name, h1, h2, h3, [data-testid*='car'], [data-testid*='vehicle'], [class*='car-name'], [class*='vehicle-name']"
      );
      const carName = normalize(carNameElement?.textContent || lines[0] || "");
      const providerImageAlt = Array.from(
        card.querySelectorAll("[class*='SupplierInfo'] img[alt], [class*='supplier'] img[alt], img[alt]")
      )
        .map((image) => normalize(image.getAttribute("alt") || ""))
        .find((alt) => {
          if (!alt || alt.length < 2 || alt.length > 80) {
            return false;
          }
          if (carName && alt.toLowerCase() === carName.toLowerCase()) {
            return false;
          }
          if (/(cars?|small|medium|large|suv|van|wagon|premium|mini|economy|compact)$/i.test(alt)) {
            return false;
          }
          return true;
        }) || "";

      const providerSelectors = [
        "[class*='SupplierInfo'] img[alt]",
        "[data-testid*='supplier']",
        "[data-testid*='provider']",
        "[class*='supplier']",
        "[class*='provider']",
        "[class*='vendor']"
      ];

      let providerName = providerImageAlt;
      for (const providerSelector of providerSelectors) {
        if (providerName) {
          break;
        }
        const element = card.querySelector(providerSelector);
        if (element) {
          const value = normalize(element.getAttribute?.("alt") || element.textContent);
          if (value) {
            providerName = value;
            break;
          }
        }
      }

      if (!providerName) {
        providerName =
          lines.find((line) => {
            if (line.length < 3 || line.length > 80) {
              return false;
            }
            if (/(price|total|book|cancellation|pay|rating|deal)/i.test(line)) {
              return false;
            }
            return /[a-z]/i.test(line);
          }) || "";
      }

      if (!providerName) {
        continue;
      }

      addCandidate(providerName, priceLine, carName, findRatingText(card), text);
    }

    return output;
  }, { transmissionFilter: context.transmission_filter || context.transmissionFilter || "" });

  const offers = [];
  for (const raw of rawCards) {
    const parsedPrice = parsePriceToNumber(raw.price_text, context.currency || "");
    if (!parsedPrice) {
      continue;
    }

    offers.push({
      location: context.location,
      provider_name: normalizeWhitespace(raw.provider_name),
      provider_rating: Number.isFinite(raw.provider_rating) ? Number(raw.provider_rating) : null,
      total_price: parsedPrice.value,
      currency: normalizeCurrencyCode(parsedPrice.currency, context.currency || ""),
      pickup_date: context.pickup_date,
      dropoff_date: context.dropoff_date,
      rental_days: context.rental_days,
      car_name: raw.car_name ? normalizeWhitespace(raw.car_name) : null,
      transmission: normalizeTransmission(raw.transmission) || null,
      source_url: context.source_url
    });
  }

  return sortOffersByPrice(dedupeOffers(offers));
}

module.exports = {
  chooseCheapestOffer,
  dedupeOffers,
  extractOffersFromDom,
  extractOffersFromPayload,
  filterOffersByTransmission,
  findTransmissionInCandidate,
  normalizeTransmission,
  normalizeTransmissionFilter,
  normalizeCurrencyCode,
  normalizeWhitespace,
  parsePriceToNumber,
  sortOffersByPrice
};
