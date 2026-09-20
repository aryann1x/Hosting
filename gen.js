const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const IMAGE_MODELS = [
	{ id: "dream_shape_lighting", name: "General", aliases: ["general", "gen"] },
	{ id: "juggernaut_lighting", name: "Realistic", aliases: ["realistic", "real"] },
	{ id: "redcraft_illustrious", name: "Realistic 2", aliases: ["real2"] },
	{ id: "ilustreal_illustrious", name: "Realistic 3", aliases: ["real3"] },
	{ id: "babes_illustrious", name: "Realistic 4", aliases: ["real4"] },
	{ id: "raemu_lighting", name: "Anime", aliases: ["anime"] },
	{ id: "wai_Illustrious", name: "Anime 2", aliases: ["anime2"] },
	{ id: "illustrij_Illustrious", name: "Anime 2.5D", aliases: ["anime2.5d"] },
	{ id: "prefect_illustrious", name: "Anime 3", aliases: ["anime3"] },
	{ id: "goddess_illustrious", name: "Realistic 6", aliases: ["real6"] },
	{ id: "perfectdeliberate_illustrious", name: "Anime 2.5D 2", aliases: ["anime2.5d2"] },
	{ id: "guofeng_sdxl", name: "GuoFeng", aliases: ["guofeng", "cn"] },
	{ id: "disney_cartoon_sdxl", name: "Disney Cartoon", aliases: ["disney", "cartoon"] },
	{ id: "samaritan_sdxl", name: "Samaritan", aliases: ["samaritan"] },
	{ id: "prefectious_illustrious", name: "Anime 4", aliases: ["anime4"] },
	{ id: "realvis_lighting", name: "Realistic 5", aliases: ["real5"] },
	{ id: "flux2_klein_fast", name: "Flux 2 Klein Fast", aliases: ["flux", "fluxfast"] },
	{ id: "flux2_klein", name: "Flux 2 Klein", aliases: ["flux2"] },
	{ id: "redzimage_zimg", name: "ZImage", aliases: ["zimage", "zimg"] }
];

const VIDEO_ENGINES = [
	{ id: "wan2_2", name: "Wan 2.2", aliases: ["wan", "wan2"], text2video: "text2video_wan", image2video: "image2video_wan" },
	{ id: "hunyuan1_5", name: "Hunyuan 1.5", aliases: ["hunyuan", "hy"], text2video: "text2video_hunyuan", image2video: "image2video_hunyuan" },
	{ id: "ltx2", name: "LTX 2", aliases: ["ltx", "ltx2"], text2video: "text2video_ltx2", image2video: "image2video_ltx2" }
];

const activeUsers = new Set();

function log(...a) { console.log("[gen]", ...a); }

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

async function downloadToFile(url, dest) {
	const res = await axios.get(url, {
		responseType: "stream",
		timeout: 180000,
		maxRedirects: 5,
		headers: {
			"User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"
		},
		validateStatus: () => true
	});
	if (res.status >= 400) throw new Error(`download HTTP ${res.status}`);
	return await new Promise((resolve, reject) => {
		const writer = fs.createWriteStream(dest);
		res.data.pipe(writer);
		writer.on("finish", () => resolve(dest));
		writer.on("error", reject);
	});
}

function uuid() {
	return crypto.randomUUID();
}

function androidId() {
	return crypto.randomBytes(8).toString("hex");
}

class AIArtGenClient {
	constructor() {
		this.appVersionCode = "831";
		this.appVersionName = "8.3.1";
		this.platform = "android";
		this.deviceId = uuid();
		this.adId = uuid();
		this.androidId = androidId();
		this.configHost = "https://config.production.aiartgen.net";
		this.accountHost = "https://account.production.aiartgen.net";
		this.syncTaskHost = "https://sync-task.production.aiartgen.net";
		this.asyncTaskHost = "https://async-task.production.aiartgen.net";
		this.bearerToken = null;
	}

	refreshGuest() {
		this.deviceId = uuid();
		this.adId = uuid();
		this.androidId = androidId();
	}

	_qp(extra = {}) {
		const p = new URLSearchParams({
			app_version_code: this.appVersionCode,
			app_version_name: this.appVersionName,
			device_id: this.deviceId,
			platform: this.platform,
			ad_id: this.adId,
			android_id: this.androidId,
			...extra
		});
		return p.toString();
	}

	async _req(url, method = "GET", body = null) {
		const headers = { "User-Agent": "Neo/1.0", "Accept-Encoding": "gzip" };
		if (this.bearerToken) headers["Authorization"] = `Bearer ${this.bearerToken}`;
		const opts = { method, url, headers, timeout: 120000, validateStatus: () => true };
		if (body) opts.data = body;
		const r = await axios(opts);
		if (r.status >= 400) {
			const err = new Error(`HTTP ${r.status}`);
			err.status = r.status;
			err.response = { status: r.status, data: r.data };
			throw err;
		}
		return r.data;
	}

	async getConfig(clientDiamonds = 0) {
		const qp = this._qp({ client_diamonds: String(clientDiamonds) });
		return await this._req(`${this.configHost}/api/v1/config?${qp}`, "GET");
	}

	async addSyncTask(prompt, opts = {}) {
		const qp = this._qp();
		const modelId = opts.modelId || "flux2_klein_fast";
		let workType = "text2img";
		if (modelId.startsWith("flux2")) workType = "flux2_text2img";
		else if (modelId.includes("zimg")) workType = "zimg_text2img";

		const payload = {
			device_id: this.deviceId,
			prompt,
			prompt_translated: prompt,
			negative_prompt: opts.negativePrompt || "",
			model_id: modelId,
			work_type: opts.workType || workType,
			width: opts.width || 756,
			height: opts.height || 1344,
			seed: opts.seed || Math.floor(Math.random() * 1000000000000),
			priority: 0,
			has_face: false,
			batch_size: 1,
			steps: opts.steps || 20,
			cfg_scale: opts.cfgScale || 7.0,
			is4k: false,
			client_diamonds: opts.clientDiamonds || 50,
			ratio: opts.ratio || "9:16",
			style: opts.style || "base"
		};
		return await this._req(`${this.syncTaskHost}/api/v1/sync_task/add?${qp}`, "POST", payload);
	}

	async getTaskStatus(taskId) {
		const qp = this._qp();
		return await this._req(`${this.syncTaskHost}/api/v1/sync_task/status/${taskId}?${qp}`, "GET");
	}

	async getTaskResult(taskId) {
		const qp = this._qp();
		return await this._req(`${this.syncTaskHost}/api/v1/sync_task/result/${taskId}?${qp}`, "GET");
	}

	async addVideoTask(prompt, opts = {}) {
		const qp = this._qp();
		const workType = opts.workType || "text2video_wan";
		const payload = {
			device_id: this.deviceId,
			prompt,
			prompt_translated: prompt,
			negative_prompt: opts.negativePrompt || "",
			model_id: "static",
			work_type: workType,
			width: 1024,
			height: 1024,
			seed: opts.seed || Math.floor(Math.random() * 1000000000000),
			priority: 0,
			has_face: false,
			batch_size: 1,
			steps: 20,
			cfg_scale: 7.0,
			is4k: false,
			client_diamonds: opts.clientDiamonds || 50,
			ratio: opts.ratio || "9:16",
			style: "",
			video_width: opts.videoWidth || 720,
			video_height: opts.videoHeight || 1280,
			video_duration: opts.videoDuration || 5,
			image_url: opts.imageUrl || ""
		};
		return await this._req(`${this.asyncTaskHost}/api/v1/async_task/add?${qp}`, "POST", payload);
	}

	async getBatchTaskStatus(taskIds) {
		const qp = this._qp();
		return await this._req(`${this.asyncTaskHost}/api/v1/async_task/batch-status?${qp}`, "POST", {
			device_id: this.deviceId,
			task_ids: taskIds
		});
	}

	async generateImage(prompt, opts = {}, onProgress = null) {
		this.refreshGuest();
		let config = await this.getConfig(0);
		let diamonds = config?.account_info?.diamonds ?? 50;

		let taskResponse;
		try {
			taskResponse = await this.addSyncTask(prompt, { ...opts, clientDiamonds: diamonds });
		} catch (err) {
			if (err.response?.status === 402) {
				this.refreshGuest();
				config = await this.getConfig(0);
				diamonds = config?.account_info?.diamonds ?? 50;
				taskResponse = await this.addSyncTask(prompt, { ...opts, clientDiamonds: diamonds });
			} else throw err;
		}

		if (!taskResponse.success || !taskResponse.task_id) {
			throw new Error(`Submit failed: ${JSON.stringify(taskResponse).slice(0, 200)}`);
		}

		const taskId = taskResponse.task_id;
		let attempts = 0;
		const maxAttempts = 60;

		while (attempts < maxAttempts) {
			await new Promise((r) => setTimeout(r, 5000));
			attempts++;
			const statusData = await this.getTaskStatus(taskId);
			const status = statusData.status;
			const progress = statusData.progress ?? 0;
			if (onProgress) onProgress(status, progress);
			if (status === "completed") break;
			if (status === "failed") throw new Error(`Task failed: ${statusData.error_message || "unknown"}`);
		}

		return await this.getTaskResult(taskId);
	}

	async generateVideo(prompt, opts = {}, onProgress = null) {
		this.refreshGuest();
		let config = await this.getConfig(0);
		let diamonds = config?.account_info?.diamonds ?? 0;

		let taskResponse;
		try {
			taskResponse = await this.addVideoTask(prompt, { ...opts, clientDiamonds: diamonds });
		} catch (err) {
			if (err.response?.status === 402) {
				this.refreshGuest();
				config = await this.getConfig(0);
				diamonds = config?.account_info?.diamonds ?? 0;
				taskResponse = await this.addVideoTask(prompt, { ...opts, clientDiamonds: diamonds });
			} else throw err;
		}

		if (!taskResponse.success || !taskResponse.task_id) {
			throw new Error(`Video submit failed: ${JSON.stringify(taskResponse).slice(0, 200)}`);
		}

		const taskId = taskResponse.task_id;
		let attempts = 0;
		const maxAttempts = 80;

		while (attempts < maxAttempts) {
			await new Promise((r) => setTimeout(r, 5000));
			attempts++;
			const batch = await this.getBatchTaskStatus([taskId]);
			const list = Array.isArray(batch) ? batch : (batch.tasks || []);
			const task = list.find((t) => t.task_id === taskId);
			if (!task) continue;
			const status = task.status;
			const progress = task.progress ?? 0;
			if (onProgress) onProgress(status, progress);
			if (status === 2 || status === "completed" || status === "success") return task;
			if (status === 3 || status === "failed") throw new Error(`Video failed: ${task.error_message || "unknown"}`);
		}
		throw new Error("Video generation timed out");
	}
}

function findImageModel(input) {
	if (!input) return null;
	const key = String(input).toLowerCase().trim();
	return IMAGE_MODELS.find((m) => m.id === input || m.aliases.includes(key) || m.name.toLowerCase() === key);
}

function findVideoEngine(input) {
	if (!input) return null;
	const key = String(input).toLowerCase().trim();
	return VIDEO_ENGINES.find((e) => e.id === input || e.aliases.includes(key) || e.name.toLowerCase() === key);
}

function extractMediaUrl(result) {
	if (!result) return null;

	try {
		log("Raw result:", JSON.stringify(result).slice(0, 800));
	} catch {}

	const direct =
		result.url ||
		result.image_url ||
		result.image ||
		result.result_url ||
		result.output_url ||
		result.output ||
		result.file_url ||
		result.cdn_url;
	if (typeof direct === "string" && direct.startsWith("http")) return direct;

	if (result.data) {
		const d = result.data;
		const nested =
			d.url ||
			d.image_url ||
			d.image ||
			d.result_url ||
			d.output_url ||
			d.output ||
			d.file_url ||
			d.cdn_url;
		if (typeof nested === "string" && nested.startsWith("http")) return nested;

		const arrs = [d.images, d.urls, d.result_urls, d.output_urls, d.results, d.files];
		for (const arr of arrs) {
			if (Array.isArray(arr) && arr.length) {
				const first = arr[0];
				if (typeof first === "string" && first.startsWith("http")) return first;
				if (first && typeof first === "object") {
					const u = first.url || first.image_url || first.url_path || first.path || first.src;
					if (typeof u === "string" && u.startsWith("http")) return u;
				}
			}
		}
	}

	const topArrs = [result.images, result.urls, result.result_urls, result.output_urls, result.results, result.files];
	for (const arr of topArrs) {
		if (Array.isArray(arr) && arr.length) {
			const first = arr[0];
			if (typeof first === "string" && first.startsWith("http")) return first;
			if (first && typeof first === "object") {
				const u = first.url || first.image_url || first.url_path || first.path || first.src;
				if (typeof u === "string" && u.startsWith("http")) return u;
			}
		}
	}

	const raw = JSON.stringify(result);
	const m = raw.match(/https?:\/\/[^\s"'<>\\]+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^\s"'<>\\]*)?/i);
	if (m) return m[0];

	const cdn = raw.match(/https?:\/\/[^\s"'<>\\]*cdn[^\s"'<>\\]*/i);
	if (cdn) return cdn[0].replace(/["',]+$/, "");

	return null;
}

function extractVideoUrl(taskStatus) {
	if (!taskStatus) return null;

	try {
		log("Video status:", JSON.stringify(taskStatus).slice(0, 800));
	} catch {}

	const direct =
		taskStatus.video_url ||
		taskStatus.video_url_hd ||
		taskStatus.videoUrl ||
		taskStatus.url ||
		taskStatus.output_url ||
		taskStatus.result_url ||
		taskStatus.video;
	if (typeof direct === "string" && direct.startsWith("http")) return direct;

	if (taskStatus.result) {
		const r = taskStatus.result;
		const u = r.video_url || r.video_url_hd || r.url || r.output_url;
		if (typeof u === "string" && u.startsWith("http")) return u;
	}

	if (taskStatus.data) {
		const d = taskStatus.data;
		const u = d.video_url || d.video_url_hd || d.url || d.output_url;
		if (typeof u === "string" && u.startsWith("http")) return u;
	}

	const raw = JSON.stringify(taskStatus);
	const m = raw.match(/https?:\/\/[^\s"'<>\\]+\.(?:mp4|webm|mov)(?:\?[^\s"'<>\\]*)?/i);
	if (m) return m[0];

	return null;
}

const USAGE = [
	"AI Art Generator",
	"--------------------",
	"",
	"Image:",
	"  gen <prompt>",
	"  gen <prompt> -m <model> -r <ratio>",
	"  gen list",
	"",
	"Video:",
	"  gen -v <prompt>",
	"  gen -v <prompt> -e <engine> -d <seconds>",
	"  gen -v -i <imageUrl> <prompt>",
	"  gen vlist",
	"",
	"Models (shortcuts):",
	"  real, real2, real3, anime, anime2, disney,",
	"  flux, flux2, zimage, guofeng, samaritan",
	"",
	"Video Engines:",
	"  wan (Wan 2.2), hunyuan (Hunyuan 1.5), ltx (LTX 2)",
	"",
	"Ratios: 1:1 9:16 16:9 3:4 4:3 2:3 3:2",
	"Duration: 5s 10s",
	"",
	"Examples:",
	"  gen a cat wearing sunglasses -m flux -r 1:1",
	"  gen -v a river flowing -e wan -d 5",
	"  gen -v -i https://example.com/img.jpg make it move"
].join("\n");

function modelsList() {
	const lines = IMAGE_MODELS.map((m, i) => `  ${String(i + 1).padStart(2)}. ${m.name.padEnd(20)} → ${m.aliases[0] || m.id}`);
	return "Image Models (" + IMAGE_MODELS.length + "):\n" + lines.join("\n");
}

function videoList() {
	const lines = VIDEO_ENGINES.map((e, i) => `  ${i + 1}. ${e.name.padEnd(20)} → ${e.aliases[0]}`);
	return "Video Engines (" + VIDEO_ENGINES.length + "):\n" + lines.join("\n") + "\n\nDurations: 5s, 10s";
}

module.exports = {
	config: {
		name: "gen",
		version: "0.0.2",
		author: "ArYAN",
		countDown: 15,
		role: 0,
		shortDescription: "AI image and video generator",
		longDescription: "Generate AI images (19 models) and videos (Wan 2.2, Hunyuan 1.5, LTX 2)",
		category: "ai",
		guide: {
			en:
				"{pn} <prompt>\n" +
				"{pn} <prompt> -m <model> -r <ratio>\n" +
				"{pn} -v <prompt> -e <engine> -d <duration>\n" +
				"{pn} -v -i <imageUrl> <prompt>\n" +
				"{pn} list\n" +
				"{pn} vlist"
		}
	},

	onStart: async function ({ api, event, args }) {
		const senderID = event.senderID;

		if (!args || args.length === 0) {
			return api.sendMessage(USAGE, event.threadID, event.messageID);
		}

		if (args[0].toLowerCase() === "list") {
			return api.sendMessage(modelsList(), event.threadID, event.messageID);
		}
		if (args[0].toLowerCase() === "vlist") {
			return api.sendMessage(videoList(), event.threadID, event.messageID);
		}

		if (activeUsers.has(senderID)) {
			return api.sendMessage("You already have a generation in progress.", event.threadID, event.messageID);
		}

		let isVideo = false;
		let model = null;
		let ratio = "1:1";
		let engine = null;
		let duration = 5;
		let resolution = "720p";
		let imageUrl = "";
		const promptParts = [];

		for (let i = 0; i < args.length; i++) {
			const a = String(args[i]).toLowerCase();
			if (a === "-v" || a === "--video") { isVideo = true; continue; }
			if (a === "-m" || a === "--model") { model = args[++i]; continue; }
			if (a === "-r" || a === "--ratio") { ratio = args[++i]; continue; }
			if (a === "-e" || a === "--engine") { engine = args[++i]; continue; }
			if (a === "-d" || a === "--duration") { duration = parseInt(args[++i]) || 5; continue; }
			if (a === "-res" || a === "--resolution") { resolution = args[++i]; continue; }
			if (a === "-i" || a === "--image") { imageUrl = args[++i]; continue; }
			promptParts.push(args[i]);
		}

		let prompt = promptParts.join(" ").trim();

		const imageAttachment = (event.messageReply?.attachments || []).find(
			(att) => att.type === "photo" || att.type === "image" || /\.(jpg|jpeg|png|webp)(?:$|[?&])/i.test(att.url || "")
		);

		if (!prompt && imageAttachment) {
			prompt = "Animate this image naturally.";
		}

		if (!prompt && !imageUrl) {
			return api.sendMessage(USAGE, event.threadID, event.messageID);
		}

		activeUsers.add(senderID);
		await setReaction(api, "⏳", event.messageID);

		let tmpDir = null;
		try {
			tmpDir = path.join(os.tmpdir(), `gen_${Date.now()}`);
			fs.mkdirSync(tmpDir, { recursive: true });

			const client = new AIArtGenClient();

			if (isVideo) {
				let workType = "text2video_wan";
				let videoUrl = imageUrl;

				if (imageAttachment && !videoUrl) {
					videoUrl = imageAttachment.url;
				}

				if (engine) {
					const eng = findVideoEngine(engine);
					if (eng) {
						workType = videoUrl ? eng.image2video : eng.text2video;
					}
				} else if (videoUrl) {
					workType = "image2video_wan";
				}

				const ratioDim = { "1:1": [720, 720], "9:16": [720, 1280], "16:9": [1280, 720], "3:4": [720, 960], "4:3": [960, 720] };
				const [vw, vh] = ratioDim[ratio] || [720, 1280];

				const resMap = { "480p": 480, "720p": 720, "1080p": 1080 };
				const baseRes = resMap[resolution] || 720;
				const scaledH = Math.round(vh * (baseRes / 720));
				const scaledW = Math.round(vw * (baseRes / 720));

				const opts = {
					workType,
					videoDuration: duration,
					videoWidth: scaledW,
					videoHeight: scaledH,
					imageUrl: videoUrl || "",
					ratio
				};

				let lastProgress = -1;
				const status = await client.generateVideo(prompt, opts, (s, p) => {
					if (typeof p === "number" && p !== lastProgress) {
						lastProgress = p;
					}
				});

				const url = extractVideoUrl(status);
				if (!url) throw new Error("No video URL returned");

				const outPath = path.join(tmpDir, `video_${Date.now()}.mp4`);
				await downloadToFile(url, outPath);
				if (!fs.statSync(outPath).size) throw new Error("Empty video");

				await setReaction(api, "✅", event.messageID);

				const body =
					`🎬 Video generated\n` +
					`📝 ${prompt.slice(0, 200)}\n` +
					`⚙️ Engine: ${engine ? (findVideoEngine(engine)?.name || engine) : "Wan 2.2"}\n` +
					`⏱ ${duration}s | 📐 ${ratio} | 🖥️ ${resolution}`;

				await sendMessageAsync(
					api,
					{ body, attachment: fs.createReadStream(outPath) },
					event.threadID,
					event.messageID
				);
			} else {
				let modelId = "flux2_klein_fast";
				if (model) {
					const m = findImageModel(model);
					if (m) modelId = m.id;
				}

				const ratioDim = { "1:1": [1024, 1024], "9:16": [768, 1344], "16:9": [1344, 768], "3:4": [896, 1152], "4:3": [1152, 896], "2:3": [832, 1216], "3:2": [1216, 832] };
				const [w, h] = ratioDim[ratio] || [1024, 1024];

				const result = await client.generateImage(prompt, { modelId, ratio, width: w, height: h });
				const imgUrl = extractMediaUrl(result);
				if (!imgUrl) throw new Error("No image URL returned");

				const outPath = path.join(tmpDir, `image_${Date.now()}.jpg`);
				await downloadToFile(imgUrl, outPath);
				if (!fs.statSync(outPath).size) throw new Error("Empty image");

				await setReaction(api, "✅", event.messageID);

				const modelName = IMAGE_MODELS.find((m) => m.id === modelId)?.name || modelId;
				const body =
					`🎨 Image generated\n` +
					`📝 ${prompt.slice(0, 200)}\n` +
					`🎭 ${modelName} | 📐 ${ratio}`;

				await sendMessageAsync(
					api,
					{ body, attachment: fs.createReadStream(outPath) },
					event.threadID,
					event.messageID
				);
			}
		} catch (err) {
			log("Error:", err.message);
			await setReaction(api, "❌", event.messageID);
			await sendMessageAsync(
				api,
				{ body: "Failed: " + String(err.message).slice(0, 400) },
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
