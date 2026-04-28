import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import * as cheerio from 'cheerio';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';

const WEBSITES         = ['https://www.bookdwellia.com'];
const YOUR_EMAIL       = process.env.YOUR_EMAIL;
const PAGESPEED_API_KEY = process.env.PAGESPEED_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_SHEET_ID  = process.env.GOOGLE_SHEET_ID;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

async function crawlSite(url) {
  const issues = [];
  try {
    const res = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(res.data);

    const title    = $('title').text();
    const metaDesc = $('meta[name="description"]').attr('content') || '';
    const h1s      = $('h1').map((i, el) => $(el).text()).get();
    const images   = $('img').map((i, el) => ({ src: $(el).attr('src'), alt: $(el).attr('alt') })).get();
    const links    = $('a[href]').map((i, el) => $(el).attr('href')).get();

    if (!title)                 issues.push('CRITICAL: No title tag found');
    else if (title.length < 30) issues.push(`WARNING: Title too short (${title.length} chars) — aim for 50-60`);
    else if (title.length > 60) issues.push(`WARNING: Title too long (${title.length} chars) — aim for 50-60`);

    if (!metaDesc)                  issues.push('CRITICAL: No meta description found');
    else if (metaDesc.length < 120) issues.push(`WARNING: Meta description too short (${metaDesc.length} chars)`);
    else if (metaDesc.length > 160) issues.push(`WARNING: Meta description too long (${metaDesc.length} chars)`);

    if (h1s.length === 0) issues.push('CRITICAL: No H1 tag found');
    if (h1s.length > 1)   issues.push(`WARNING: Multiple H1 tags (${h1s.length}) — use only one`);

    const noAlt = images.filter(img => !img.alt).length;
    if (noAlt > 0) issues.push(`WARNING: ${noAlt} image(s) missing alt text`);

    const httpLinks = links.filter(l => l && l.startsWith('http:')).length;
    if (httpLinks > 0) issues.push(`WARNING: ${httpLinks} non-HTTPS link(s) found`);

    return { url, title, metaDesc, h1s, totalImages: images.length, noAlt, totalLinks: links.length, issues };
  } catch (e) {
    return { url, issues: [`CRITICAL: Could not crawl — ${e.message}`] };
  }
}

async function getPageSpeed(url) {
  try {
    const res = await axios.get(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${PAGESPEED_API_KEY}&strategy=mobile`
    );
    const cats   = res.data.lighthouseResult.categories;
    const audits = res.data.lighthouseResult.audits;
    return {
      performance:   Math.round((cats.performance?.score   || 0) * 100),
      accessibility: Math.round((cats.accessibility?.score || 0) * 100),
      seo:           Math.round((cats.seo?.score           || 0) * 100),
      lcp: audits['largest-contentful-paint']?.displayValue || 'unknown',
      cls: audits['cumulative-layout-shift']?.displayValue  || 'unknown',
      tbt: audits['total-blocking-time']?.displayValue      || 'unknown',
    };
  } catch (e) {
    return { error: `PageSpeed failed: ${e.message}` };
  }
}

async function analyzeWithClaude(crawlData, speedData, url) {
  const prompt = `You are an expert SEO consultant. Analyze this data and provide:
1. An overall SEO health score (0-100)
2. Top 3 critical issues to fix this week (be specific)
3. Top 3 improvements ranked by ranking impact
4. One content suggestion to improve search visibility

Website: ${url}
Date: ${new Date().toDateString()}

CRAWL DATA:
${JSON.stringify(crawlData, null, 2)}

PAGESPEED SCORES:
${JSON.stringify(speedData, null, 2)}

Be specific and actionable. Plain text with clear section headers. Concise enough to read in 3 minutes.`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content[0].text;
}

async function saveToSheets(crawlData, speedData, analysis, url) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const date = new Date().toLocaleDateString();

  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: 'Weekly Reports!A:G',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        date,
        url,
        speedData.performance   || 'N/A',
        speedData.seo           || 'N/A',
        speedData.accessibility || 'N/A',
        crawlData.issues?.length || 0,
        analysis.substring(0, 500),
      ]]
    }
  });

  if (crawlData.issues?.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Issues Log!A:C',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: crawlData.issues.map(issue => [date, url, issue])
      }
    });
  }
}

async function sendEmail(allResults) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: YOUR_EMAIL, pass: GMAIL_APP_PASSWORD }
  });

  const totalIssues = allResults.reduce((sum, r) => sum + (r.crawl.issues?.length || 0), 0);
  const subject = `SEO Weekly Report — ${totalIssues} issue${totalIssues !== 1 ? 's' : ''} found · ${new Date().toLocaleDateString()}`;

  const sections = allResults.map(r => `
    <h2>${r.url}</h2>
    <h3>Scores</h3>
    <ul>
      <li>Performance: ${r.speed.performance || 'N/A'}/100</li>
      <li>SEO: ${r.speed.seo || 'N/A'}/100</li>
      <li>Accessibility: ${r.speed.accessibility || 'N/A'}/100</li>
      <li>Largest Contentful Paint: ${r.speed.lcp || 'N/A'}</li>
      <li>Total Blocking Time: ${r.speed.tbt || 'N/A'}</li>
    </ul>
    <h3>Issues Found (${r.crawl.issues?.length || 0})</h3>
    <ul>${(r.crawl.issues || []).map(i => `<li>${i}</li>`).join('')}</ul>
    <h3>AI Analysis &amp; Recommendations</h3>
    <pre style="font-family:sans-serif;white-space:pre-wrap">${r.analysis}</pre>
    <hr>
  `).join('');

  const html = `
    <h1>Weekly SEO Report</h1>
    ${sections}
    <small>
      Generated by your SEO Agent ·
      <a href="https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}">View full history in Google Sheets</a>
    </small>
  `;

  await transporter.sendMail({ from: YOUR_EMAIL, to: YOUR_EMAIL, subject, html });
}

export default async function handler(req, res) {
  try {
    console.log('SEO Agent starting...');
    const allResults = [];

    for (const url of
