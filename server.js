const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const Anthropic = require("@anthropic-ai/sdk");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Serve the frontend
app.use(express.static("public"));

// ── Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", version: "1.0.0" });
});

// ── Scrape a website and extract SEO data
async function scrapeWebsite(url) {
  try {
    // Normalize URL
    if (!url.startsWith("http")) url = "https://" + url;

    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; RankReady-SEO-Bot/1.0; +https://rankready.app)",
      },
    });

    const $ = cheerio.load(response.data);
    const result = {};

    // Title tag
    result.title = $("title").first().text().trim() || null;

    // Meta description
    result.metaDescription =
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      null;

    // H1 tags
    result.h1s = [];
    $("h1").each((i, el) => {
      const text = $(el).text().trim();
      if (text) result.h1s.push(text);
    });

    // H2 tags (first 10)
    result.h2s = [];
    $("h2").each((i, el) => {
      if (i >= 10) return false;
      const text = $(el).text().trim();
      if (text) result.h2s.push(text);
    });

    // Images without alt text
    let totalImages = 0;
    let imagesWithoutAlt = 0;
    $("img").each((i, el) => {
      totalImages++;
      const alt = $(el).attr("alt");
      if (!alt || alt.trim() === "") imagesWithoutAlt++;
    });
    result.totalImages = totalImages;
    result.imagesWithoutAlt = imagesWithoutAlt;

    // Internal vs external links
    let internalLinks = 0;
    let externalLinks = 0;
    const domain = new URL(url).hostname;
    $("a[href]").each((i, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      if (href.startsWith("http") && !href.includes(domain)) {
        externalLinks++;
      } else {
        internalLinks++;
      }
    });
    result.internalLinks = internalLinks;
    result.externalLinks = externalLinks;

    // Check for canonical tag
    result.canonical = $('link[rel="canonical"]').attr("href") || null;

    // Check for schema markup
    result.hasSchema = $('script[type="application/ld+json"]').length > 0;

    // Check for Open Graph tags
    result.hasOpenGraph = $('meta[property^="og:"]').length > 0;

    // Full visible body text — for address, phone, location extraction
    // Remove script and style tags first so we get clean readable text
    $("script, style, noscript").remove();
    const bodyText = $("body").text().replace(/\s+/g, " ").trim();
    result.wordCount = bodyText.split(" ").filter((w) => w.length > 0).length;

    // Extract first 2000 chars of visible body text for address/contact detection
    result.visibleText = bodyText.slice(0, 2000);

    // Look for address patterns in the page
    const addressPatterns = [
      /\d+\s+[A-Za-z0-9\s,]+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl)[^<]{0,60}/gi,
      /(?:Valencia|Santa Clarita|Los Angeles|[A-Z][a-z]+),\s*CA\s*\d{5}/g,
    ];
    const addressMatches = [];
    addressPatterns.forEach(pattern => {
      const matches = bodyText.match(pattern);
      if (matches) addressMatches.push(...matches.slice(0, 3));
    });
    result.addressesFound = [...new Set(addressMatches)].slice(0, 5);

    // Look for phone numbers
    const phoneMatches = bodyText.match(/(?:\+1[-.\s]?)?(?:\(?[0-9]{3}\)?[-.\s]?)[0-9]{3}[-.\s]?[0-9]{4}/g);
    result.phonesFound = phoneMatches ? [...new Set(phoneMatches)].slice(0, 3) : [];

    // Schema markup content — extract actual JSON-LD data
    result.schemaContent = [];
    $('script[type="application/ld+json"]').each((i, el) => {
      if (i >= 3) return false;
      try {
        const parsed = JSON.parse($(el).text());
        result.schemaContent.push(parsed);
      } catch(e) {}
    });

    // Page load URL (final URL after redirects)
    result.finalUrl = response.request.res?.responseUrl || url;
    result.statusCode = response.status;

    // Robots meta
    result.robotsMeta =
      $('meta[name="robots"]').attr("content") || "not specified";

    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      note: "Could not scrape website — audit will use provided details only",
    };
  }
}

// ── Run the SEO audit
app.post("/api/audit", async (req, res) => {
  const { bizName, bizType, websiteUrl, location, bizDesc } = req.body;

  if (!bizName || !bizType || !websiteUrl || !location) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Scrape the website first
  const scrapeResult = await scrapeWebsite(websiteUrl);
  const siteData = scrapeResult.success ? scrapeResult.data : null;

  // Build the prompt — include real scraped data if available
  let scrapedContext = "";
  if (siteData) {
    scrapedContext = `
ACTUAL DATA SCRAPED FROM THEIR WEBSITE:
- Page Title: ${siteData.title || "MISSING — no title tag found"}
- Meta Description: ${siteData.metaDescription || "MISSING — no meta description found"}
- H1 Tags Found: ${siteData.h1s.length > 0 ? siteData.h1s.join(" | ") : "NONE FOUND — critical issue"}
- H2 Tags Found: ${siteData.h2s.length > 0 ? siteData.h2s.slice(0, 6).join(" | ") : "None found"}
- Images: ${siteData.totalImages} total, ${siteData.imagesWithoutAlt} missing alt text
- Internal Links: ${siteData.internalLinks}
- External Links: ${siteData.externalLinks}
- Has Schema Markup: ${siteData.hasSchema ? "Yes" : "NO — missing"}
- Has Open Graph Tags: ${siteData.hasOpenGraph ? "Yes" : "NO — missing"}
- Canonical Tag: ${siteData.canonical || "NOT SET"}
- Robots Meta: ${siteData.robotsMeta}
- Estimated Word Count: ${siteData.wordCount} words
- HTTP Status: ${siteData.statusCode}
- Addresses Found on Page: ${siteData.addressesFound && siteData.addressesFound.length > 0 ? siteData.addressesFound.join(" | ") : "None detected"}
- Phone Numbers Found: ${siteData.phonesFound && siteData.phonesFound.length > 0 ? siteData.phonesFound.join(" | ") : "None detected"}
- Schema Markup Data: ${siteData.schemaContent && siteData.schemaContent.length > 0 ? JSON.stringify(siteData.schemaContent[0]).slice(0, 300) : "None found"}
- Visible Page Text Sample: ${siteData.visibleText ? siteData.visibleText.slice(0, 800) : "Not available"}

CRITICAL INSTRUCTION: Use ONLY the data above for factual details like address, phone number, city, and location. Do NOT use your training data to fill in details like the business address or city — only state what was actually found on the page. If the address above shows "Valencia" then say Valencia. If no address was found, say so.`;
  } else {
    scrapedContext = `NOTE: Could not scrape the website directly (${scrapeResult.error}). Base the audit on the business details provided and general best practices for this type of business.`;
  }

  const prompt = `You are an expert local SEO consultant conducting a real audit. Be specific, reference the actual data where available, and write like you've genuinely reviewed this business's website.

BUSINESS DETAILS:
- Name: ${bizName}
- Type: ${bizType}
- Website: ${websiteUrl}
- Location: ${location}
- Notes: ${bizDesc || "None provided"}

${scrapedContext}

Return ONLY valid JSON, no markdown, no text outside the JSON:
{
  "overallScore": <0-100, based on actual findings>,
  "scoreLabel": "<Poor|Fair|Good|Excellent>",
  "executiveSummary": "<2-3 paragraphs referencing specific findings from the scraped data. Name actual issues found.>",
  "keywordAnalysis": "<8-12 keyword phrases to target with search intent. Include city-specific variants for ${location}.>",
  "onPageIssues": {
    "critical": ["<reference actual missing/broken elements found>", "<issue>", "<issue>"],
    "warnings": ["<issue>", "<issue>", "<issue>"],
    "positives": ["<positive>", "<positive>"]
  },
  "localSEO": "<GBP optimization, local citations, NAP consistency, reviews, schema, local pages — specific to ${bizType} in ${location}>",
  "competitorGaps": "<what competitors are likely doing better, specific gaps to close>",
  "contentStrategy": "<5-6 blog/page ideas with descriptions tailored to their industry and location>",
  "priorityActions": ["<specific action referencing actual findings>", "<action>", "<action>", "<action>", "<action>", "<action>"],
  "timelineEstimate": "<30 days, 90 days, 6 months expectations>",
  "scrapedData": ${JSON.stringify(siteData || null)}
}`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = message.content.map((b) => b.text || "").join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    res.json({
      success: true,
      report: { ...parsed, bizName, bizUrl: websiteUrl, bizCity: location, bizType },
      scrapeSuccess: scrapeResult.success,
    });
  } catch (err) {
    res.status(500).json({ error: "Audit generation failed: " + err.message });
  }
});

// ── Generate content
app.post("/api/content", async (req, res) => {
  const { contentType, bizName, bizType, bizUrl, bizCity, keywordAnalysis } = req.body;

  if (!contentType || !bizName) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const prompts = {
    blog: `Write a full SEO-optimized blog post for ${bizName}, a ${bizType} in ${bizCity}. Target keywords: ${(keywordAnalysis || "").slice(0, 300)}. 600-800 words, H1 title, 3-4 H2s, CTA at end. Return ONLY valid JSON: {"title":"...","metaDescription":"...","body":"..."}`,
    meta: `Write optimized meta titles and descriptions for 5 key pages of ${bizName}, a ${bizType} in ${bizCity}. Titles under 60 chars, descriptions under 155. Keywords: ${(keywordAnalysis || "").slice(0, 200)}. Return ONLY valid JSON: {"pages":[{"page":"...","metaTitle":"...","metaDescription":"..."}]}`,
    service: `Rewrite the main service page for ${bizName}, a ${bizType} in ${bizCity}. 400-500 words: headline, what they do, why choose them, service area, CTA. Return ONLY valid JSON: {"headline":"...","body":"...","cta":"..."}`,
    faq: `Write 8 FAQ questions and answers for ${bizName}, a ${bizType} in ${bizCity}. Target long-tail and voice search. Return ONLY valid JSON: {"faqs":[{"question":"...","answer":"..."}]}`,
    gbp: `Write an optimized Google Business Profile for ${bizName}, a ${bizType} in ${bizCity}. Description under 750 chars, plus 3 GBP posts at 150-200 words each. Return ONLY valid JSON: {"description":"...","posts":[{"title":"...","body":"..."}]}`,
  };

  try {
    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompts[contentType] + "\n\nReturn ONLY valid JSON." }],
    });

    const raw = message.content.map((b) => b.text || "").join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    res.json({ success: true, data: parsed });
  } catch (err) {
    res.status(500).json({ error: "Content generation failed: " + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RankReady server running on port ${PORT}`);
});