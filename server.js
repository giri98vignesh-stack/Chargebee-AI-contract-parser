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

      // Extract text from PDF — try pdf2json first, then Python pypdf fallback
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      let rawText = '';

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

      // Method 2: Python pypdf (handles compressed/ASCII85 PDFs)
      if (!rawText) {
        try {
          const tmpFile = require('path').join(require('os').tmpdir(), 'cb_contract_' + Date.now() + '.pdf');
          require('fs').writeFileSync(tmpFile, pdfBuffer);
          const pyScript = 'from pypdf import PdfReader; r = PdfReader(\'' + tmpFile.replace(/\\/g, '/') + '\'); print(chr(10).join(p.extract_text() or \"\" for p in r.pages))';
          // Try python3 first, then python
          rawText = await new Promise((resolve) => {
            const tryPython = (cmd) => {
              execFile(cmd, ['-c', pyScript], { timeout: 10000 }, (err, stdout) => {
                if (!err && stdout && stdout.trim().length > 20) {
                  resolve(stdout.trim());
                } else if (cmd === 'python3') {
                  tryPython('python');
                } else {
                  resolve('');
                }
              });
            };
            tryPython('python3');
          });
          try { require('fs').unlinkSync(tmpFile); } catch(e) {}
        } catch(e) { console.log('Python failed:', e.message); rawText = ''; }
      }

      // Method 3: Raw buffer text extraction (last resort)
      if (!rawText || rawText.length < 50) {
        const latin = pdfBuffer.toString('latin1');
        const parens = latin.match(/\(([^)]{2,200})\)/g) || [];
        const words = parens
          .map(p => { try { return decodeURIComponent(p.slice(1,-1)); } catch(e) { return p.slice(1,-1); } })
          .filter(t => /[a-zA-Z]{3,}/.test(t) && !/^[^a-zA-Z]*$/.test(t));
        rawText = words.join(' ').replace(/\s+/g, ' ').trim();
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
      const result = await httpsRequest({
        hostname: cbSite + '.chargebee.com',
        path: '/api/v2/' + endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(formData),
          'Authorization': authHeader
        }
      }, formData);

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
