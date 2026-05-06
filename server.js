const http = require('http');
const { execFile } = require('child_process');
const os = require('os');
const PDFParser = require('pdf2json');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

// ── Helper: read full request body ──
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Helper: HTTPS request ──
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    // 15 second timeout so it never hangs
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out after 15 seconds')); });
    if (body) req.write(body);
    req.end();
  });
}

// ── CORS headers ──
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Main server ──
const server = http.createServer(async (req, res) => {
  cors(res);

  // Preflight
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve the HTML file
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // ── /api/extract — Groq + pdf2json extraction ──
  if (req.method === 'POST' && req.url === '/api/extract') {
    try {
      const body = await readBody(req);
      const { pdfBase64 } = JSON.parse(body.toString());

      const GROQ_KEY = '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';

      // Extract text from PDF — pdf2json for uncompressed, ASCII85+zlib for compressed
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      let rawText = '';

      // ASCII85 decoder (handles ReportLab compressed PDFs)
      function ascii85decode(src) {
        src = src.replace(/\s/g, '').replace(/~>$/, '');
        const out = [];
        let i = 0;
        while (i < src.length) {
          if (src[i] === 'z') { out.push(0,0,0,0); i++; continue; }
          const group = src.slice(i, i+5);
          if (group.length === 0) break;
          let acc = 0;
          for (let j = 0; j < 5; j++) acc = acc * 85 + (j < group.length ? group.charCodeAt(j) - 33 : 84);
          const bytes = [(acc>>>24)&0xff,(acc>>>16)&0xff,(acc>>>8)&0xff,acc&0xff];
          const take = group.length < 5 ? group.length - 1 : 4;
          for (let j = 0; j < take; j++) out.push(bytes[j]);
          i += 5;
        }
        return Buffer.from(out);
      }

      // Method 1: pdf2json (works for uncompressed PDFs)
      try {
        rawText = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), 8000);
          const pdfParser = new PDFParser();
          pdfParser.on('pdfParser_dataReady', pdfData => {
            clearTimeout(timer);
            let text = '';
            for (const page of pdfData.Pages || []) {
              for (const t of page.Texts || []) {
                for (const r of t.R || []) {
                  try { text += decodeURIComponent(r.T) + ' '; } catch(e) { text += r.T + ' '; }
                }
              }
              text += '\n';
            }
            resolve(text.trim());
          });
          pdfParser.on('pdfParser_dataError', err => { clearTimeout(timer); reject(new Error(String(err.parserError || err))); });
          pdfParser.parseBuffer(pdfBuffer);
        });
        if (rawText.length < 50) rawText = '';
      } catch(e) { console.log('pdf2json failed:', e.message); rawText = ''; }

      // Method 2: ASCII85 + FlateDecode (handles ReportLab/compressed PDFs)
      if (!rawText || rawText.length < 50) {
        try {
          const zlib = require('zlib');
          const str = pdfBuffer.toString('binary');
          let allText = '';
          // Find all streams
          let searchStr = str;
          let offset = 0;
          while (true) {
            const sIdx = searchStr.indexOf('stream');
            if (sIdx < 0) break;
            const eIdx = searchStr.indexOf('endstream', sIdx);
            if (eIdx < 0) break;
            const streamContent = searchStr.slice(sIdx + 7, eIdx - 1);
            // Try ASCII85 + inflate
            try {
              const decoded = ascii85decode(streamContent);
              const inflated = zlib.inflateSync(decoded).toString('latin1');
              const texts = inflated.match(/\(([^)]{1,300})\)/g) || [];
              for (const t of texts) {
                const clean = t.slice(1,-1).replace(/\\[0-9]{3}/g,' ');
                if (/[a-zA-Z@.]{2,}/.test(clean)) allText += clean + ' ';
              }
            } catch(e2) {
              // Try direct inflate
              try {
                const buf2 = Buffer.from(streamContent, 'binary');
                const inflated = zlib.inflateSync(buf2).toString('latin1');
                const texts = inflated.match(/\(([^)]{1,300})\)/g) || [];
                for (const t of texts) {
                  const clean = t.slice(1,-1);
                  if (/[a-zA-Z@.]{2,}/.test(clean)) allText += clean + ' ';
                }
              } catch(e3) {}
            }
            searchStr = searchStr.slice(eIdx + 9);
          }
          if (allText.trim().length > 50) rawText = allText.replace(/\s+/g,' ').trim();
        } catch(e) { console.log('ASCII85 extraction failed:', e.message); }
      }

      // Method 3: Raw printable strings fallback
      if (!rawText || rawText.length < 50) {
        const latin = pdfBuffer.toString('latin1');
        const matches = latin.match(/[ -~]{5,}/g) || [];
        const meaningful = matches.filter(m => /[a-zA-Z]{3,}/.test(m) && !/^[^a-zA-Z]*$/.test(m));
        rawText = meaningful.join(' ').replace(/\s+/g,' ').trim().slice(0, 5000);
      }

            console.log('PDF text extracted, length:', rawText.length);
      console.log('Sample:', rawText.slice(0, 300));

      const prompt = "You are a contract parser for a SaaS billing system. Extract subscription and customer details from this contract text. Return ONLY a valid JSON object with NO markdown, NO backticks, NO extra text. Use this exact schema: { \"customer\": { \"first_name\": \"\", \"last_name\": \"\", \"email\": \"\", \"phone\": \"\", \"company\": \"\" }, \"subscription\": { \"plan\": \"pro-monthly|pro-yearly|business-monthly|business-yearly|starter-monthly\", \"quantity\": 1, \"billing_period\": \"month|year\", \"start_date\": \"YYYY-MM-DD\", \"unit_price\": 0, \"currency\": \"INR|USD|EUR|GBP\" }, \"billing\": { \"discount_percent\": 0, \"contract_duration_months\": null, \"notes\": \"\" }, \"confidence\": { \"email\": \"high|medium|low\", \"start_date\": \"high|medium|low\", \"discount\": \"high|medium|low\", \"notes\": \"high|medium|low\" } }. Contract text: " + rawText.slice(0, 5000);

      const payload = JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
        temperature: 0.1
      });

      const result = await httpsRequest({
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Authorization': 'Bearer ' + GROQ_KEY
        }
      }, payload);

      const groqData = JSON.parse(result.body);
      console.log('Groq status:', result.status);

      if (groqData.error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: groqData.error.message } }));
        return;
      }

      const text = groqData.choices[0].message.content;
      console.log('Groq response:', text.slice(0, 300));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text }] }));

    } catch (e) {
      console.error('Extraction error:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /api/chargebee — Chargebee proxy ──
  if (req.method === 'POST' && req.url === '/api/chargebee') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body.toString());
      const endpoint = parsed.endpoint;
      const formData = parsed.formData;
      // Use hardcoded Chargebee credentials — ignore what browser sends
      const cbSite = 'girivignesh-test';
      const cbKey = 'test_UwfNYZNdkseBeC0RQcd1ykGM4N8b3mgyN';

      console.log('Chargebee call:', endpoint);
      console.log('FormData:', formData.slice(0, 200));

      const authHeader = 'Basic ' + Buffer.from(cbKey + ':').toString('base64');
      // Support GET-style list endpoints passed as POST
      const isListRequest = endpoint.includes('?');
      const method = isListRequest ? 'GET' : 'POST';
      const urlPath = '/api/v2/' + endpoint;
      const result = await httpsRequest({
        hostname: cbSite + '.chargebee.com',
        path: urlPath,
        method: method,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': isListRequest ? 0 : Buffer.byteLength(formData),
          'Authorization': authHeader
        }
      }, isListRequest ? null : formData);

      console.log('Chargebee response status:', result.status);
      console.log('Chargebee response body:', result.body.slice(0, 300));

      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body);
    } catch (e) {
      console.error('Chargebee proxy error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ✅ Chargebee Contract Intelligence server running');
  console.log('  👉 Open http://localhost:' + PORT + ' in your browser');
  console.log('');
});
