const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const FormData = require("form-data");
const { chromium } = require("playwright");

const TEMP_MAIL_DOMAIN = process.env.MY_DOMAIN_URL || "wudysoft.my.id";
const BASE_URL = "https://claude.ai";
const DEFAULT_MODEL = "claude-sonnet-5";

const activeUsers = new Set();

let browserInstance = null;
let cfCookies = null;
let cfCookiesTime = 0;
const CF_TTL = 25 * 60 * 1000;

function log(...a) { console.log("[agent]", ...a); }

function setReaction(api, r, id) {
	return new Promise((res) => {
		try { api.setMessageReaction(r, id, () => res(), true); } catch { res(); }
	});
}

function sendMessageAsync(api, msg, tid, mid) {
	return new Promise((res) => {
		let done = false;
		const finish = (_, info) => {
			if (done) return;
			done = true;
			clearTimeout(t);
			res(info || null);
		};
		const t = setTimeout(() => finish(null, null), 300000);
		try {
			const r = api.sendMessage(msg, tid, finish, mid);
			if (r && typeof r.then === "function") r.then((i) => finish(null, i)).catch(() => finish(null, null));
		} catch { finish(null, null); }
	});
}

function splitMessage(text, max = 1900) {
	if (!text) return [""];
	if (text.length <= max) return [text];
	const parts = [];
	let remaining = text;
	while (remaining.length > 0) {
		let chunk = remaining.slice(0, max);
		const lastNl = chunk.lastIndexOf("\n");
		if (lastNl > max * 0.6) chunk = chunk.slice(0, lastNl);
		parts.push(chunk);
		remaining = remaining.slice(chunk.length).trimStart();
	}
	return parts;
}

async function getBrowser() {
	if (browserInstance && browserInstance.isConnected()) return browserInstance;
	log("Launching chromium...");
	browserInstance = await chromium.launch({
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-gpu",
			"--disable-blink-features=AutomationControlled"
		]
	});
	return browserInstance;
}

async function solveCloudflare() {
	if (cfCookies && Date.now() - cfCookiesTime < CF_TTL) {
		log("Using cached CF cookies");
		return cfCookies;
	}

	log("Solving Cloudflare challenge...");
	const browser = await getBrowser();
	const context = await browser.newContext({
		userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36",
		viewport: { width: 1366, height: 900 }
	});
	const page = await context.newPage();

	try {
		await page.goto("https://claude.ai/login", { waitUntil: "domcontentloaded", timeout: 60000 });
		await page.waitForTimeout(8000);

		let html = await page.content();
		if (html.includes("Just a moment") || html.includes("Checking your browser")) {
			log("CF challenge detected, waiting...");
			await page.waitForTimeout(15000);
			html = await page.content();
		}

		const cookies = await context.cookies();
		const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
		log(`Got ${cookies.length} CF cookies`);

		cfCookies = cookieStr;
		cfCookiesTime = Date.now();
		return cookieStr;
	} finally {
		await context.close();
	}
}

function buildAuthHeaders(ctx, extra = {}) {
	const headers = {
		authority: "claude.ai",
		accept: "*/*",
		"accept-language": "en-US,en;q=0.9",
		"anthropic-anonymous-id": ctx.anonymousId,
		"anthropic-client-platform": "web_claude_ai",
		"anthropic-client-sha": "e6d5ac949ef7d8040d371aa4d26d342f240308cb",
		"anthropic-client-version": "1.0.0",
		"anthropic-device-id": ctx.deviceId,
		"content-type": "application/json",
		origin: BASE_URL,
		referer: BASE_URL + "/",
		"user-agent": ctx.WEB_UA,
		"x-activity-session-id": ctx.activitySessionId
	};
	const cookies = Array.from(ctx.cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
	if (cookies) headers["Cookie"] = cookies;
	return Object.assign(headers, extra);
}

function buildChatHeaders(ctx, extra = {}) {
	const headers = {
		authority: "claude.ai",
		accept: "*/*",
		"accept-language": "en-US",
		"anthropic-client-platform": "android",
		"anthropic-client-app": "com.anthropic.claude",
		"anthropic-client-version": "1.260611.30",
		"anthropic-client-os-version": "36",
		"anthropic-device-id": ctx.deviceId,
		"content-type": "application/json; charset=UTF8",
		origin: BASE_URL,
		referer: BASE_URL + "/",
		"user-agent": ctx.WEB_UA,
		"accept-encoding": "gzip, deflate, br",
		priority: "u=1, i"
	};
	const cookies = Array.from(ctx.cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
	if (cookies) headers["Cookie"] = cookies;
	return Object.assign(headers, extra);
}

function setCookies(ctx, raw) {
	const arr = Array.isArray(raw) ? raw : [raw];
	for (const c of arr) {
		const pair = c.split(";")[0];
		const idx = pair.indexOf("=");
		if (idx < 0) continue;
		const name = pair.slice(0, idx).trim();
		const val = pair.slice(idx + 1);
		if (name) ctx.cookies.set(name, val || "");
	}
}

async function authRequest(ctx, method, urlPath, { body = null, headers = {} } = {}) {
	const bodyBuf = body ? JSON.stringify(body) : null;
	const reqHeaders = buildAuthHeaders(ctx, {
		...(bodyBuf ? { "Content-Length": String(Buffer.byteLength(bodyBuf)) } : {}),
		...headers
	});
	try {
		const response = await axios({
			method,
			url: BASE_URL + urlPath,
			data: bodyBuf,
			headers: reqHeaders,
			timeout: 60000,
			validateStatus: () => true
		});
		if (response.headers["set-cookie"]) setCookies(ctx, response.headers["set-cookie"]);
		if (response.status === 403) {
			throw new Error("CLOUDFLARE_403");
		}
		if (response.status >= 400) {
			throw new Error(`HTTP_${response.status}: ${JSON.stringify(response.data).slice(0, 200)}`);
		}
		return response.data;
	} catch (err) {
		if (err.response?.headers?.["set-cookie"]) setCookies(ctx, err.response.headers["set-cookie"]);
		if (err.response?.status === 403) throw new Error("CLOUDFLARE_403");
		throw new Error(err.response ? `HTTP_${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}` : err.message);
	}
}

async function chatRequest(ctx, method, urlPath, { body = null, headers = {} } = {}) {
	const bodyBuf = body ? JSON.stringify(body) : null;
	const reqHeaders = buildChatHeaders(ctx, {
		...(bodyBuf ? { "Content-Length": String(Buffer.byteLength(bodyBuf)) } : {}),
		...headers
	});
	try {
		const response = await axios({
			method,
			url: BASE_URL + urlPath,
			data: bodyBuf,
			headers: reqHeaders,
			timeout: 60000,
			validateStatus: () => true
		});
		if (response.headers["set-cookie"]) setCookies(ctx, response.headers["set-cookie"]);
		if (response.status === 403) throw new Error("CLOUDFLARE_403");
		if (response.status >= 400) {
			throw new Error(`HTTP_${response.status}: ${JSON.stringify(response.data).slice(0, 200)}`);
		}
		return response.data;
	} catch (err) {
		if (err.response?.headers?.["set-cookie"]) setCookies(ctx, err.response.headers["set-cookie"]);
		if (err.response?.status === 403) throw new Error("CLOUDFLARE_403");
		const errorData = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
		throw new Error(`HTTP_${err.response?.status || "UNKNOWN"}: ${errorData}`);
	}
}

async function streamRequest(ctx, urlPath, body, extraHeaders = {}) {
	const bodyStr = JSON.stringify(body);
	const headers = buildChatHeaders(ctx, {
		accept: "text/event-stream",
		"Content-Type": "application/json; charset=UTF8",
		"Content-Length": Buffer.byteLength(bodyStr),
		...extraHeaders
	});
	try {
		const response = await axios({
			method: "POST",
			url: BASE_URL + urlPath,
			data: bodyStr,
			headers,
			responseType: "stream",
			timeout: 120000,
			validateStatus: () => true
		});
		if (response.headers["set-cookie"]) setCookies(ctx, response.headers["set-cookie"]);
		if (response.status === 403) throw new Error("CLOUDFLARE_403");
		if (response.status >= 400) {
			let err = "";
			for await (const c of response.data) err += c;
			throw new Error(`Stream HTTP_${response.status}: ${err.slice(0, 200)}`);
		}
		return response.data;
	} catch (err) {
		if (err.response?.status === 403) throw new Error("CLOUDFLARE_403");
		const errorData = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
		throw new Error(`Stream HTTP_${err.response?.status || "UNKNOWN"}: ${errorData}`);
	}
}

function getMimeType(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	const mimeTypes = {
		".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
		".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
		".txt": "text/plain", ".csv": "text/csv", ".json": "application/json",
		".md": "text/markdown", ".html": "text/html"
	};
	return mimeTypes[ext] || "application/octet-stream";
}

async function uploadFile(ctx, orgId, convId, fileInput) {
	let fileBuffer, fileName, mimeType;
	if (typeof fileInput === "string") {
		fileBuffer = fs.readFileSync(fileInput);
		fileName = path.basename(fileInput);
		mimeType = getMimeType(fileInput);
	} else if (Buffer.isBuffer(fileInput)) {
		fileBuffer = fileInput;
		fileName = `upload_${Date.now()}.bin`;
		mimeType = "application/octet-stream";
	} else if (typeof fileInput === "object" && fileInput !== null) {
		fileBuffer = fileInput.buffer;
		fileName = fileInput.fileName || `upload_${Date.now()}.bin`;
		mimeType = fileInput.mimeType || "application/octet-stream";
	} else throw new Error("Invalid file input");

	const formData = new FormData();
	formData.append("file", fileBuffer, { filename: fileName, contentType: mimeType });

	const url = `/api/organizations/${orgId}/conversations/${convId}/wiggle/upload-file`;
	const headers = buildChatHeaders(ctx, { ...formData.getHeaders() });

	const response = await axios({
		method: "POST",
		url: BASE_URL + url,
		data: formData,
		headers,
		timeout: 120000,
		validateStatus: () => true
	});
	if (response.headers["set-cookie"]) setCookies(ctx, response.headers["set-cookie"]);
	if (response.status >= 400) throw new Error(`Upload HTTP_${response.status}`);
	return response.data.uuid;
}

async function getArkoseToken(ctx) {
	const esyncValue = String(Math.floor(Date.now() / 1e3) - 1e5);
	const r = () => crypto.randomBytes(32).toString("base64");
	const params = new URLSearchParams({
		c: `${r()}==${r()}==${r()}==${r()}`,
		public_key: "EEA5F558-D6AC-4C03-B678-AABF639EE69A",
		site: BASE_URL,
		userbrowser: ctx.WEB_UA,
		capi_version: "4.2.2",
		capi_mode: "lightbox",
		style_theme: "default",
		rnd: Math.random().toString()
	});
	const response = await axios({
		method: "POST",
		url: `https://a-cdn.claude.ai/fc/gt2/public_key/EEA5F558-D6AC-4C03-B678-AABF639EE69A`,
		data: params.toString(),
		headers: {
			"content-type": "application/x-www-form-urlencoded; charset=UTF-8",
			"user-agent": ctx.WEB_UA,
			"x-ark-esync-value": esyncValue
		},
		timeout: 15000,
		validateStatus: () => true
	});
	return response.data.token;
}

async function sendMagicLink(ctx, email) {
	const res = await authRequest(ctx, "POST", "/api/auth/send_magic_link", {
		body: { utc_offset: ctx.utcOffset, email_address: email, locale: ctx.locale, source: "claude" }
	});
	if (!res.sent) throw new Error("Failed to send magic link");
	return res;
}

async function verifyMagicLink(ctx, email, code) {
	const arkoseToken = await getArkoseToken(ctx);
	const res = await authRequest(ctx, "POST", "/api/auth/verify_magic_link", {
		body: {
			credentials: { method: "code", email_address: email, code: String(code) },
			locale: ctx.locale,
			arkose_session_token: arkoseToken,
			source: "claude"
		}
	});
	if (!res.success) throw new Error("OTP verification failed");
	const chatOrg = (res.account.memberships || []).find((m) => m.organization.capabilities?.includes("chat"));
	ctx.orgId = chatOrg?.organization.uuid || res.account.memberships?.[0]?.organization.uuid || null;
	return res;
}

async function exchangeNonceForCode(ctx, nonce, encodedEmailAddress) {
	const res = await authRequest(ctx, "POST", "/api/auth/exchange_nonce_for_code", {
		body: { nonce, encoded_email_address: encodedEmailAddress, source: "claude" }
	});
	return res.code;
}

async function loginWithMagicLink(ctx, magicLinkUrl) {
	const fragment = magicLinkUrl.split("#")[1];
	if (!fragment) throw new Error("No fragment in magic link");
	const [nonce, encodedEmail] = fragment.split(":");
	if (!nonce || !encodedEmail) throw new Error("Invalid fragment format");
	const email = Buffer.from(encodedEmail, "base64").toString("utf8");
	const code = await exchangeNonceForCode(ctx, nonce, encodedEmail);
	return verifyMagicLink(ctx, email, code);
}

async function waitForMagicLink(emailAddress, maxAttempts = 30, intervalMs = 3000) {
	for (let i = 0; i < maxAttempts; i++) {
		log(`Polling email (${i + 1}/${maxAttempts})...`);
		try {
			const response = await axios.get(`https://${TEMP_MAIL_DOMAIN}/api/mails/v9`, {
				params: { action: "message", email: emailAddress },
				timeout: 15000,
				validateStatus: () => true
			});
			const messages = response.data?.data || [];
			if (messages.length > 0) {
				const content = messages[0].text_content || messages[0].html_content || "";
				const match = content.match(/https:\/\/claude\.ai\/magic-link#[a-f0-9]+:[A-Za-z0-9%+=]+/);
				if (match) {
					log("Magic link found!");
					return match[0];
				}
			}
		} catch (e) { /* ignore */ }
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error("Timeout: no magic link received");
}

async function ensureAuth(ctx) {
	try {
		const orgs = await authRequest(ctx, "GET", "/api/organizations");
		if (orgs && orgs.length > 0) {
			ctx.orgId = orgs[0].uuid;
			return;
		}
	} catch (e) {
		if (e.message !== "CLOUDFLARE_403") {
			log("Starting auto signup...");
		}
	}

	const createRes = await axios.get(`https://${TEMP_MAIL_DOMAIN}/api/mails/v9`, {
		params: { action: "create" },
		timeout: 15000,
		validateStatus: () => true
	});
	const email = createRes.data.email;
	log(`Temp email: ${email}`);

	await sendMagicLink(ctx, email);
	const magicLinkUrl = await waitForMagicLink(email);
	await loginWithMagicLink(ctx, magicLinkUrl);
	log(`Authenticated. orgId: ${ctx.orgId}`);
}

async function runClaudeChat(prompt, files = [], thinkingMode = true, model = DEFAULT_MODEL) {
	const ctx = {
		cookies: new Map(),
		anonymousId: "claudeai.v1." + crypto.randomUUID(),
		deviceId: crypto.randomUUID(),
		activitySessionId: crypto.randomUUID(),
		orgId: null,
		convId: null,
		model,
		locale: "en-US",
		utcOffset: 360,
		WEB_UA: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"
	};

	// Step 1: Solve Cloudflare and get cf_clearance cookie
	const cfCookieStr = await solveCloudflare();
	log("CF cookies obtained");

	// Parse and inject into ctx.cookies
	for (const pair of cfCookieStr.split("; ")) {
		const idx = pair.indexOf("=");
		if (idx < 0) continue;
		ctx.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
	}

	// Step 2: Auth with Claude
	await ensureAuth(ctx);

	// Step 3: Create conversation
	const convRes = await chatRequest(ctx, "POST", `/api/organizations/${ctx.orgId}/chat_conversations`, {
		body: { name: "", model: ctx.model },
		headers: { accept: "application/json" }
	});
	ctx.convId = convRes.uuid;

	// Step 4: Upload files
	const fileUuids = [];
	for (const f of files) {
		try {
			const uuid = await uploadFile(ctx, ctx.orgId, ctx.convId, f);
			if (uuid) fileUuids.push(uuid);
		} catch (e) {
			log("File upload failed:", e.message);
		}
	}

	// Step 5: Send completion
	const body = {
		prompt,
		timezone: "Asia/Dhaka",
		model: ctx.model,
		attachments: [],
		files: fileUuids,
		rendering_mode: "messages",
		input_mode: "text",
		effort: thinkingMode ? "xhigh" : "low",
		thinking_mode: thinkingMode ? "auto" : "off",
		tools: [
			{ name: "repl", type: "repl_v0" },
			{ name: "web_search", type: "web_search_v0" }
		]
	};

	const stream = await streamRequest(
		ctx,
		`/api/organizations/${ctx.orgId}/chat_conversations/${ctx.convId}/completion`,
		body,
		{ referer: `${BASE_URL}/chat/${ctx.convId}` }
	);

	await new Promise((resolve, reject) => {
		stream.on("end", resolve);
		stream.on("error", reject);
		stream.resume();
	});

	// Step 6: Fetch result
	const getUrl = `/api/organizations/${ctx.orgId}/chat_conversations/${ctx.convId}?rendering_mode=messages&render_all_mobile_tools=true&return_dangling_human_message=true&include_extracted_content=false`;

	let res = null;
	for (let i = 0; i < 5; i++) {
		res = await chatRequest(ctx, "GET", getUrl, { headers: { accept: "application/json" } });
		const messages = res.chat_messages || [];
		const lastMsg = messages[messages.length - 1];
		if (lastMsg && lastMsg.sender === "assistant" && lastMsg.stop_reason === "end_turn") break;
		await new Promise((r) => setTimeout(r, 1000));
	}

	const messages = res.chat_messages || [];
	const lastAssistant = messages.filter((m) => m.sender === "assistant").pop();
	return lastAssistant ? lastAssistant.content : [];
}

function formatContent(content) {
	let replyText = "";
	if (!content || !content.length) return "No response.";

	for (const block of content) {
		if (block.type === "text") {
			replyText += block.text + "\n\n";
		} else if (block.type === "thinking") {
			const formatted = block.thinking.split("\n").map((line) => (line.trim() ? `> ${line}` : "")).join("\n");
			replyText += `${formatted}\n\n`;
		} else if (block.type === "tool_use") {
			replyText += `> 🔧 Tool: ${block.name}\n`;
			if (block.input?.query) replyText += `> Query: ${block.input.query}\n`;
			replyText += "\n";
		}
	}
	return replyText.trim() || "No text response.";
}

const USAGE = [
	"🤖 Agent — Claude AI",
	"",
	"Usage:",
	"  agent <prompt>",
	"  agent -m <model> <prompt>",
	"  agent -nothink <prompt>",
	"  (reply to file/image) agent <prompt>",
	"",
	"Models: claude-sonnet-5, claude-opus-4-8, claude-haiku-4-5",
	"",
	"Example:",
	"  agent Hello",
	"  agent -m claude-opus-4-8 Explain quantum physics"
].join("\n");

module.exports = {
	config: {
		name: "agent",
		version: "0.0.2",
		author: "ArYAN",
		countDown: 10,
		role: 0,
		shortDescription: "Chat with Claude AI (Cloudflare bypass)",
		longDescription: "Claude AI via claude.ai with auto-signup + Playwright Cloudflare bypass",
		category: "ai",
		guide: {
			en:
				"{pn} <prompt>\n" +
				"{pn} -m <model> <prompt>\n" +
				"{pn} -nothink <prompt>\n" +
				"(reply file/image) {pn} <prompt>"
		}
	},

	onStart: async function ({ api, event, args }) {
		const senderID = event.senderID;

		if (!args || args.length === 0) {
			const attachment = (event.messageReply?.attachments || [])[0];
			if (!attachment) {
				return api.sendMessage(USAGE, event.threadID, event.messageID);
			}
		}

		if (activeUsers.has(senderID)) {
			return api.sendMessage("⏳ You already have a request in progress.", event.threadID, event.messageID);
		}

		let model = DEFAULT_MODEL;
		let thinkingMode = true;
		const promptParts = [];

		for (let i = 0; i < (args || []).length; i++) {
			const a = String(args[i]);
			if (a === "-m" || a === "--model") {
				model = String(args[++i] || DEFAULT_MODEL);
				continue;
			}
			if (a === "-nothink" || a === "--no-think") {
				thinkingMode = false;
				continue;
			}
			promptParts.push(args[i]);
		}

		let prompt = promptParts.join(" ").trim();
		if (!prompt && event.messageReply?.body) {
			prompt = String(event.messageReply.body).trim();
		}
		if (!prompt) prompt = "Analyze the attached file/image.";

		activeUsers.add(senderID);
		await setReaction(api, "⏳", event.messageID);

		let tmpDir = null;
		try {
			tmpDir = path.join(os.tmpdir(), `agent_${Date.now()}`);
			fs.mkdirSync(tmpDir, { recursive: true });

			const files = [];
			const attachment = (event.messageReply?.attachments || [])[0];

			if (attachment && attachment.url) {
				log("Downloading attachment...");
				const res = await axios.get(attachment.url, {
					responseType: "arraybuffer",
					timeout: 60000,
					validateStatus: () => true
				});
				if (res.status >= 400) throw new Error(`Download HTTP ${res.status}`);
				const buffer = Buffer.from(res.data);
				const ext = path.extname((attachment.url || "").split("?")[0]) || ".jpg";
				const fileName = `upload_${Date.now()}${ext}`;
				files.push({
					buffer,
					fileName,
					mimeType: attachment.mimetype || getMimeType(fileName)
				});
				log(`Attachment: ${fileName} (${(buffer.length / 1024).toFixed(0)} KB)`);
			}

			log(`Prompt: ${prompt.slice(0, 100)} | Model: ${model} | Files: ${files.length}`);

			const content = await runClaudeChat(prompt, files, thinkingMode, model);
			const replyText = formatContent(content);

			await setReaction(api, "✅", event.messageID);

			const parts = splitMessage(replyText);
			for (const p of parts) {
				await sendMessageAsync(api, { body: p }, event.threadID, event.messageID);
			}
		} catch (err) {
			log("Error:", err.message);
			await setReaction(api, "❌", event.messageID);
			let errorMsg = String(err.message).slice(0, 400);
			if (err.message === "CLOUDFLARE_403") {
				errorMsg = "Cloudflare blocked the request. The bot's IP may be rate-limited. Please try again in a few minutes.";
			}
			await sendMessageAsync(
				api,
				{ body: "Failed: " + errorMsg },
				event.threadID,
				event.messageID
			);
		} finally {
			activeUsers.delete(senderID);
			setTimeout(() => {
				try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
			}, 30000);
		}
	}
};
