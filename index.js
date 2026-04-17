const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, Browsers, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.static('public'));

// Remove old sessions to prevent memory leak
function clearOldSessions(sessionDir) {
    setTimeout(() => {
        try {
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                console.log(`Cleaned up session: ${sessionDir}`);
            }
        } catch (e) {
            console.error("Cleanup error:", e);
        }
    }, 10 * 60 * 1000); // 10 minutes
}

app.get('/', (req, res) => {
    res.json({ creator: "XENO HEX", message: "Alive!" });
});

app.get('/pair', async (req, res) => {
    let number = req.query.number;
    
    if (!number || number.length < 5) {
        return res.status(400).json({ error: "Invalid phone number" });
    }
    
    number = number.replace(/[^0-9]/g, '');

    const sessionId = 'XenoExe_' + crypto.randomUUID();
    const sessionDir = path.join(__dirname, 'sessions', sessionId);
    
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            browser: Browsers.ubuntu("Chrome"),
            printQRInTerminal: false,
            markOnlineOnConnect: false
        });

        if (!sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    let pairingCode = await sock.requestPairingCode(number);
                    // Match the exact format of the reference repo
                    pairingCode = pairingCode || "";
                    
                    if (!res.headersSent) {
                        res.json({ code: pairingCode, session: sessionId });
                    }
                } catch (error) {
                    console.error("Error requesting pairing code:", error);
                    if (!res.headersSent) {
                        res.status(400).json({ error: "Invalid phone number" });
                    }
                }
            }, 6000);
        }

        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                await delay(2000);
                console.log(`Session connected for ${number}`);
                
                try {
                    const credsPath = path.join(sessionDir, 'creds.json');
                    const credsData = fs.readFileSync(credsPath);
                    const b64Data = Buffer.from(credsData).toString('base64');
                    const xenoSessionId = `XenoExe~${b64Data}`;

                    await sock.sendMessage(sock.user.id, { 
                        text: `*✅ SESSION GENERATED SUCCESSFULLY ✅*\n\n*SESSION ID:*\n\`\`\`${xenoSessionId}\`\`\`\n\n_Don't share this session ID with anyone._\n\n📌 *To use it, paste it in your bot's SESSION_ID environment variable.*` 
                    });
                    
                    await delay(1000);
                    // Also send the document as backup
                    await sock.sendMessage(sock.user.id, { 
                        document: credsData,
                        mimetype: 'application/json',
                        fileName: 'creds.json'
                    });

                    console.log(`Sent credentials to ${sock.user.id}`);
                } catch (err) {
                    console.error("Error sending creds message:", err);
                } finally {
                    await delay(1000);
                    sock.ws.close();
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
            } else if (connection === 'close') {
                let reason = lastDisconnect?.error?.output?.statusCode;
                if (reason === 401 || reason === 403) {
                    try {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    } catch(e) {}
                }
            }
        });

        // Ensure leftover files are deleted after a timeout
        clearOldSessions(sessionDir);

    } catch (e) {
        console.error(e);
        if (!res.headersSent) {
            res.status(500).json({ error: "An internal server error occurred." });
        }
    }
});

app.listen(PORT, () => {
    console.log(`Server is running beautifully on http://localhost:${PORT}`);
});
