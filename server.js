require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");
const http = require("http");
const socketIO = require("socket.io");
const {
    RTCPeerConnection,
    RTCSessionDescription,
    RTCIceCandidate,
    MediaStream,
} = require("wrtc");

// STUN server allows each peer to discover its public IP for NAT traversal
const ICE_SERVERS = [{ urls: "stun:stun.relay.metered.ca:80" }];
console.log("ICE servers configured:", ICE_SERVERS);
console.log("Server initialization started at:", new Date().toISOString());

const WHATSAPP_API_URL = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/calls`;
const ACCESS_TOKEN = `Bearer ${process.env.ACCESS_TOKEN}`;
console.log("WhatsApp API URL configured:", WHATSAPP_API_URL);
console.log("Phone Number ID:", process.env.PHONE_NUMBER_ID);

const app = express();
const server = http.createServer(app);
const io = socketIO(server);
console.log("Express server and Socket.IO initialized");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// State variables per call session
let browserPc = null;
let browserStream = null;
let whatsappPc = null;
let whatsappStream = null;
let browserOfferSdp = null;
let whatsappOfferSdp = null;
let browserSocket = null;
let currentCallId = null;
let callInProgress = false; // New flag to track active call state

/**
 * Socket.IO connection from browser client.
 */
io.on("connection", (socket) => {
    console.log(`Socket.IO connection established with browser: ${socket.id}`);
    console.log(`Client connection time: ${new Date().toISOString()}`);
    console.log(`Total connected clients: ${io.engine.clientsCount}`);

    // SDP offer from browser
    socket.on("browser-offer", async (sdp, callId) => {
        console.log("Received SDP offer from browser.");
        console.log("SDP offer first 100 chars:", sdp.substring(0, 100) + "...");
        console.log("SDP offer received at:", new Date().toISOString());
        console.log("SDP offer media lines:", sdp.match(/m=.*/g));
        console.log("Call ID provided with offer:", callId);
        
        browserOfferSdp = sdp;
        browserSocket = socket;
        
        // If callId is provided, use it to ensure we're processing the right call
        if (callId) {
            currentCallId = callId;
            console.log("Using provided callId for WebRTC bridge:", callId);
        }
        
        await initiateWebRTCBridge();
    });

    // ICE candidate from browser
    socket.on("browser-candidate", async (candidate) => {
        console.log("Received ICE candidate from browser:", candidate.candidate.substring(0, 30) + "...");
        console.log("ICE candidate type:", candidate.type);
        console.log("ICE candidate SDPMid:", candidate.sdpMid);
        console.log("ICE candidate SDPMLineIndex:", candidate.sdpMLineIndex);
        console.log("ICE candidate received at:", new Date().toISOString());
        
        if (!browserPc) {
            console.warn("Cannot add ICE candidate: browser peer connection not initialized.");
            return;
        }

        try {
            await browserPc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.error("Failed to add ICE candidate from browser:", err);
        }
    });

    // Reject call from browser
    socket.on("reject-call", async (callId) => {
        console.log(`Call rejection request received for callId: ${callId}`);
        console.log(`Rejection time: ${new Date().toISOString()}`);
        console.log(`Rejecting client: ${socket.id}`);
        const result = await rejectCall(callId);
        console.log("Reject call response:", result);
        
        // Reset call in progress flag
        callInProgress = false;
        console.log("Call in progress flag reset after rejection");
    });

    // Accept call from browser - new handler for explicit call acceptance
    socket.on("accept-call", async (callId) => {
        console.log(`Call acceptance request received for callId: ${callId}`);
        console.log(`Acceptance time: ${new Date().toISOString()}`);
        console.log(`Accepting client: ${socket.id}`);
        
        // Store this socket for the accepted call
        browserSocket = socket;
        currentCallId = callId;
        
        // If we already have the WhatsApp SDP offer but not the browser one yet,
        // we need to wait for the browser-offer event
        if (whatsappOfferSdp && !browserOfferSdp) {
            console.log("We have WhatsApp offer but waiting for browser offer");
            console.log("Browser will send offer after this acceptance");
        } 
        // If we have both offers already, we can initiate the WebRTC bridge now
        else if (whatsappOfferSdp && browserOfferSdp) {
            console.log("We have both offers, can initiate WebRTC bridge immediately");
            await initiateWebRTCBridge();
        } else {
            console.log("Waiting for required SDP offers:");
            console.log("- Browser offer exists:", !!browserOfferSdp);
            console.log("- WhatsApp offer exists:", !!whatsappOfferSdp);
        }
    });

    // Terminate call from browser
    socket.on("terminate-call", async (callId) => {
        console.log(`Call termination request received for callId: ${callId}`);
        console.log(`Termination time: ${new Date().toISOString()}`);
        console.log(`Terminating client: ${socket.id}`);
        const result = await terminateCall(callId);
        console.log("Terminate call response:", result);
        
        // Reset call in progress flag
        callInProgress = false;
        console.log(`Call in progress flag reset to FALSE at ${new Date().toISOString()}`);
        console.log("Call in progress flag reset after termination");
    });
    
    // Handle client disconnection
    socket.on("disconnect", () => {
        console.log(`Client disconnected: ${socket.id}`);
        
        // If this was the browser socket for our call, reset the flag
        if (socket.id === browserSocket?.id) {
            callInProgress = false;
            console.log("Call in progress flag reset due to browser client disconnection");
        }
    });
    
    // Smart Call - Combined permission check & call
    socket.on("smart-call", async ({ phoneNumber }) => {
        try {
            console.log(`Smart call requested for ${phoneNumber}`);
            console.log(`Starting smart call flow at ${new Date().toISOString()}`);
            
            // Format the phone number (remove + if present)
            const formattedNumber = phoneNumber.replace(/^\+/, '');
            console.log(`Formatted number for WhatsApp API: ${formattedNumber}`);
            // Store this socket for further communication
            browserSocket = socket;
            
            // Check if the user already has permission
            let permissionStatus;
            try {
                permissionStatus = await checkCallPermission(formattedNumber);
            } catch (error) {
                console.error("Error checking permission, assuming no permission:", error);
                permissionStatus = { hasPermission: false, status: "error" };
            }
            
            // If permission is already granted, directly make the call
            if (permissionStatus.hasPermission) {
                console.log(`✅ User already has permission for ${phoneNumber} - Making call directly`);
                console.log(`Permission status: ${JSON.stringify(permissionStatus)}`);
                
                socket.emit("call-status", "Permission already granted. Making call directly...");
                
                // Make the call
                console.log(`Initiating direct call to ${formattedNumber}`);
                const result = await initiateDirectCall(formattedNumber);
                console.log(`Direct call initiation result: ${JSON.stringify(result)}`);
                
                if (result.success) {
                    // Call initiated successfully
                    socket.emit("call-initiated");
                    console.log(`📱 Call initiated to ${phoneNumber}, call_id: ${result.call_id}`);
                    currentCallId = result.call_id;
                } else {
                    console.error(`❌ Failed to initiate call to ${phoneNumber}:`, result);
                    
                    // Check for specific error code - permission error
                    if (result.data?.error?.code === 138006) {
                        socket.emit("call-failed", "No approved call permission from recipient. Sending permission request...");
                        
                        // Permission denied - send permission request
                        socket.emit("permission-needed", { phoneNumber: formattedNumber });
                        
                        // Send permission request
                        const permResult = await sendCallPermissionRequest(formattedNumber);
                        
                        if (permResult.success) {
                            socket.emit("permission-request-sent", { 
                                phoneNumber: formattedNumber,
                                messageId: permResult.messageId
                            });
                            console.log(`📩 Permission request sent to ${phoneNumber}`);
                        } else {
                            socket.emit("permission-request-failed", permResult.error || "Unknown error");
                            console.error(`❌ Failed to send permission request:`, permResult);
                        }
                    } else {
                        socket.emit("call-failed", result.error || "Failed to initiate call");
                    }
                }
                
                return;
            }
            
            // No permission - send permission request
            console.log(`⛔ No permission for ${phoneNumber} - Sending permission request first`);
            console.log(`Permission status details: ${JSON.stringify(permissionStatus)}`);
            
            socket.emit("permission-needed", { phoneNumber: formattedNumber });
            
            // Send permission request via WhatsApp API
            console.log(`Sending permission request to ${formattedNumber}`);
            const result = await sendCallPermissionRequest(formattedNumber);
            console.log(`Permission request result: ${JSON.stringify(result)}`);
            
            if (result.success) {
                socket.emit("permission-request-sent", { 
                    phoneNumber: formattedNumber,
                    messageId: result.messageId
                });
                console.log(`📩 Permission request sent to ${phoneNumber}, messageId: ${result.messageId}`);
            } else {
                socket.emit("permission-request-failed", result.error || "Unknown error");
                console.error(`❌ Failed to send permission request:`, result);
            }
        } catch (error) {
            socket.emit("call-failed", error.message);
            console.error("❌ Error in smart call flow:", error);
        }
    });
    
    // Initiate outgoing call to WhatsApp
    socket.on("initiate-call", async ({ phoneNumber }) => {
        try {
            console.log(`Initiating direct call to ${phoneNumber}`);
            
            // Format the phone number (remove + if present)
            const formattedNumber = phoneNumber.replace(/^\+/, '');
            
            // Store this socket for the outgoing call
            browserSocket = socket;
            
            let permissionStatus;
            
            try {
                // First check if the user has permission
                permissionStatus = await checkCallPermission(formattedNumber);
                
                // If no permission, notify the user
                if (!permissionStatus.hasPermission) {
                    socket.emit("call-failed", "No approved call permission from the recipient. Please send a permission request first (Step 1) and wait for the user to approve.");
                    console.log(`⛔ No call permission for ${phoneNumber} - Permission status: ${permissionStatus.status}`);
                    return;
                }
                
                // We have permission, so initiate the call
                console.log(`✅ Permission granted for ${phoneNumber} - Proceeding with call`);
            } catch (error) {
                // If permission check fails, log the error but proceed with the call anyway
                console.warn(`⚠️ Permission check failed for ${phoneNumber}, proceeding with call attempt:`, error.message);
                socket.emit("call-status", "Permission check failed, attempting call directly...");
            }
            
            // Make the actual call
            const result = await initiateDirectCall(formattedNumber);
            
            if (result.success) {
                // Call initiated successfully
                socket.emit("call-initiated");
                console.log(`📱 Call initiated to ${phoneNumber}, call_id: ${result.call_id}`);
                currentCallId = result.call_id;
                
                // Now we wait for the WebRTC setup via the regular webhook flow
            } else {
                console.error(`❌ Failed to initiate call to ${phoneNumber}:`, result);
                
                // Check for specific error code - permission error
                if (result.data?.error?.code === 138006) {
                    socket.emit("call-failed", "No approved call permission from recipient. Please send a permission request first (Step 1) and wait for the user to approve.");
                } else {
                    socket.emit("call-failed", result.error || "Failed to initiate call");
                }
            }
        } catch (error) {
            socket.emit("call-failed", error.message);
            console.error(`❌ Error initiating call:`, error);
        }
    });
});

/**
 * Handles incoming WhatsApp webhook call events.
 */
// Handle webhook verification (GET request)
app.get("/call-events", (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_secret_token";
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("Webhook verified successfully!");
        res.status(200).send(challenge);
    } else {
        console.warn("Webhook verification failed");
        res.sendStatus(403);
    }
});

// Handle actual call events (POST request)
app.post("/call-events", async (req, res) => {
    try {
        const entry = req.body?.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;
        
        console.log("Webhook received at:", new Date().toISOString());
        console.log("Webhook headers:", JSON.stringify(req.headers, null, 2));
        console.log("Webhook payload:", JSON.stringify(req.body, null, 2));
        
        // Check if this is a call event
        if (value?.calls && value.calls.length > 0) {
            const call = value.calls[0];
            const contact = value?.contacts?.[0];

            console.log("Call event detected:", call?.event);
            console.log("Call details:", JSON.stringify(call));

            if (!call || !call.id || !call.event) {
                console.warn("Received invalid or incomplete call event.");
                return res.sendStatus(200);
            }

            const callId = call.id;
            currentCallId = callId;

            if (call.event === "connect") {
                whatsappOfferSdp = call?.session?.sdp;
                const callerName = contact?.profile?.name || "Unknown";
                const callerNumber = contact?.wa_id || "Unknown";

                console.log(`Incoming WhatsApp call from ${callerName} (${callerNumber})`);
                console.log(`Call ID: ${callId}`);
                console.log(`SDP offer from WhatsApp (first 100 chars): ${whatsappOfferSdp?.substring(0, 100)}...`);
                
                // io.emit("call-is-coming", { callId, callerName, callerNumber });
                console.log("Emitted call-is-coming event to all clients");

                await initiateWebRTCBridge();
                console.log("WebRTC bridge initiated for incoming call");

            } else if (call.event === "terminate") {
                console.log(`WhatsApp call terminated. Call ID: ${callId}`);
                console.log(`Termination reason: ${call.reason || "Not specified"}`);
                
                io.emit("call-ended");
                console.log("Emitted call-ended event to all clients");
                
                // Reset call in progress flag
                callInProgress = false;
                console.log("Call in progress flag reset after WhatsApp user terminated the call");

                if (call.duration && call.status) {
                    console.log(`Call duration: ${call.duration}s | Status: ${call.status}`);
                }

            } else {
                console.log(`Unhandled WhatsApp call event: ${call.event}`);
            }
        } 
        // Check if this is a permission response event via call_permissions array
        else if (value?.call_permissions && value.call_permissions.length > 0) {
            const permission = value.call_permissions[0];
            const waId = permission.wa_id;
            const status = permission.status;
            
            console.log(`📱 Call permission status update for ${waId}: ${status}`);
            
            // Notify all connected clients about the permission update
            io.emit("call-permission-update", {
                phoneNumber: waId,
                status: status
            });
            
            // If we have a specific browser socket for this permission request, notify it directly
            if (browserSocket) {
                browserSocket.emit("call-permission-update", {
                    phoneNumber: waId,
                    status: status
                });
                
                // If permission was granted, we could automatically initiate a call if requested
                if (status === "granted") {
                    console.log(`✅ Permission granted for ${waId} - Client will auto-call if requested`);
                }
            }
        } 
        // Check if this is a message status update
        else if (value?.statuses && value.statuses.length > 0) {
            const status = value.statuses[0];
            console.log(`Message status update: ${status.status} for message ${status.id}`);
            
            // If this is a status update for a permission request message, we can track it
            if (status.status === "delivered" || status.status === "read") {
                io.emit("message-status-update", {
                    messageId: status.id,
                    status: status.status
                });
            }
        }
        // Check for interactive message with call permission reply (alternative format)
        else if (value?.messages && value.messages.length > 0) {
            const message = value.messages[0];
            console.log("Received message from user:", message.from);
            
            // Check if this is a call permission reply message
            if (message.type === "interactive" && 
                message.interactive?.type === "call_permission_reply" && 
                message.interactive?.call_permission_reply) {
                
                const permissionReply = message.interactive.call_permission_reply;
                const response = permissionReply.response;  // "accept" or "reject"
                const waId = message.from;
                const callerName = value?.contacts?.[0]?.profile?.name || "Unknown User";
                
                console.log(`📱 Call permission reply from ${callerName} (${waId}): ${response}`);
                
                // Map the response to a status
                const status = response === "accept" ? "granted" : "denied";
                
                // Notify all connected clients about the permission update
                io.emit("call-permission-update", {
                    phoneNumber: waId,
                    callerName: callerName,
                    status: status
                });
                
                // If we have a specific browser socket for this permission request, notify it directly
                if (browserSocket) {
                    browserSocket.emit("call-permission-update", {
                        phoneNumber: waId,
                        status: status
                    });
                    
                    // If permission was granted, we MUST automatically initiate a call
                    if (status === "granted" && waId) {
                        console.log(`✅ Permission granted for ${callerName} (${waId}) - Auto-initiating call NOW...`);
                        
                        // Auto-initiate call since permission was just granted - 
                        // This is CRITICAL for ensuring the call happens right after permission is granted
                        browserSocket.emit("call-status", "Permission granted! Initiating call automatically...");
                        
                        // Make the call immediately - the user is waiting
                        try {
                            // Delay slightly to ensure the client is ready
                            setTimeout(async () => {
                                try {
                                    const callResult = await initiateDirectCall(waId);
                                    if (callResult.success) {
                                        // Call initiated successfully - send caller name too
                                        browserSocket.emit("call-initiated", { callerName });
                                        console.log(`📱 Auto-call initiated to ${callerName} (${waId}), call_id: ${callResult.call_id}`);
                                        currentCallId = callResult.call_id;
                                    } else {
                                        browserSocket.emit("call-failed", callResult.error || "Failed to initiate auto-call");
                                        console.error(`❌ Failed to initiate auto-call to ${waId}:`, callResult);
                                        
                                        // Try again after a short delay - sometimes the API needs a moment
                                        setTimeout(async () => {
                                            console.log("Retrying call after short delay...");
                                            const retryResult = await initiateDirectCall(waId);
                                            if (retryResult.success) {
                                                browserSocket.emit("call-initiated", { callerName });
                                                console.log(`📱 Retry call initiated to ${callerName} (${waId}), call_id: ${retryResult.call_id}`);
                                                currentCallId = retryResult.call_id;
                                            } else {
                                                browserSocket.emit("call-failed", retryResult.error || "Failed to initiate call on retry");
                                                console.error(`❌ Failed to initiate call on retry:`, retryResult);
                                            }
                                        }, 2000);
                                    }
                                } catch (innerError) {
                                    console.error("Error in delayed call:", innerError);
                                    browserSocket.emit("call-failed", "Error initiating delayed call: " + innerError.message);
                                }
                            }, 1000);
                        } catch (callError) {
                            console.error("Error initiating auto-call:", callError);
                            browserSocket.emit("call-failed", "Error initiating auto-call: " + callError.message);
                        }
                    }
                }
            } else {
                // This is just a regular message
                console.log("Regular message received, not related to call permissions");
            }
        }

        res.sendStatus(200);
    } catch (err) {
        console.error("Error processing /call-events webhook:", err);
        res.sendStatus(200); // Still return 200 even on error to prevent retries
    }
});

// Webhook verification endpoint for Meta (WhatsApp Cloud API)
app.get("/call-events", (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_secret_token";
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
        // Token matches, respond with challenge
        res.status(200).send(challenge);
    } else {
        // Token does not match
        res.sendStatus(403);
    }
});

/**
 * Initiates WebRTC between browser and WhatsApp once both SDP offers are received.
 */
async function initiateWebRTCBridge() {
    console.log("\n===== INITIATING WEBRTC BRIDGE =====");
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Call ID: ${currentCallId}`);
    
    // Check for call in progress to prevent duplicate connections
    if (callInProgress) {
        console.log("Call already in progress. Not initiating another WebRTC bridge.");
        console.log("Current call ID:", currentCallId);
        console.log("Call state time:", new Date().toISOString());
        return;
    }
    
    if (!browserOfferSdp || !whatsappOfferSdp || !browserSocket) {
        console.log("Missing required data to initiate WebRTC bridge:");
        console.log("- Browser offer SDP exists:", !!browserOfferSdp);
        console.log("- WhatsApp offer SDP exists:", !!whatsappOfferSdp);
        console.log("- Browser Socket exists:", !!browserSocket);
        console.log("Bridge initiation attempt time:", new Date().toISOString());
        return;
    }
    
    // Set call in progress flag
    callInProgress = true;
    console.log(`Call in progress flag set to TRUE at ${new Date().toISOString()}`);
    console.log(`Current callId: ${currentCallId}`);
    
    console.log("Initiating WebRTC bridge between browser and WhatsApp...");
    console.log(`Bridge initiation started at: ${new Date().toISOString()}`);
    console.log("Memory usage:", process.memoryUsage());
    console.log("Current active calls:", currentCallId ? 1 : 0);

    try {
        // --- Setup browser peer connection ---
        console.log("Setting up browser peer connection...");
        console.log("Setup time:", new Date().toISOString());
        browserPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        browserStream = new MediaStream();
        console.log("Browser peer connection created with ICE servers:", ICE_SERVERS);
        console.log("Browser peer connection state:", browserPc.connectionState);
        console.log("Browser ICE gathering state:", browserPc.iceGatheringState);
        console.log("Browser signaling state:", browserPc.signalingState);

        browserPc.ontrack = (event) => {
            console.log("Audio track received from browser.");
            console.log("Track details:", event.track.id, event.track.kind, event.track.label);
            console.log("Track received at:", new Date().toISOString());
            console.log("Track readyState:", event.track.readyState);
            console.log("Track enabled:", event.track.enabled);
            console.log("Track muted:", event.track.muted);
            
            event.streams[0].getTracks().forEach((track) => {
                browserStream.addTrack(track);
                console.log("Added browser audio track:", track.id, track.kind);
            });
        };

        browserPc.onicecandidate = (event) => {
            if (event.candidate) {
                console.log("Browser ICE candidate:", event.candidate.candidate.substr(0, 50) + "...");
                browserSocket.emit("browser-candidate", event.candidate);
            }
        };

        browserPc.oniceconnectionstatechange = () => {
            console.log("Browser ICE connection state:", browserPc.iceConnectionState);
            console.log("ICE state change time:", new Date().toISOString());
            
            if (browserPc.iceConnectionState === 'connected') {
                console.log("Browser ICE connection CONNECTED successfully");
            } else if (browserPc.iceConnectionState === 'disconnected') {
                console.log("Browser ICE connection DISCONNECTED");
            } else if (browserPc.iceConnectionState === 'failed') {
                console.error("Browser ICE connection FAILED");
            } else if (browserPc.iceConnectionState === 'closed') {
                console.log("Browser ICE connection CLOSED");
            }
        };

        await browserPc.setRemoteDescription(new RTCSessionDescription({
            type: "offer",
            sdp: browserOfferSdp
        }));
        console.log("Browser offer SDP set as remote description.");

        // --- Setup WhatsApp peer connection ---
        whatsappPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        console.log("WhatsApp peer connection created at:", new Date().toISOString());
        console.log("WhatsApp PC state:", whatsappPc.connectionState);
        console.log("WhatsApp ICE gathering state:", whatsappPc.iceGatheringState);
        console.log("WhatsApp signaling state:", whatsappPc.signalingState);
        
        whatsappPc.oniceconnectionstatechange = () => {
            console.log("WhatsApp ICE connection state:", whatsappPc.iceConnectionState);
            console.log("WhatsApp ICE state change time:", new Date().toISOString());
            
            if (whatsappPc.iceConnectionState === 'connected') {
                console.log("WhatsApp ICE connection CONNECTED successfully");
            } else if (whatsappPc.iceConnectionState === 'disconnected') {
                console.log("WhatsApp ICE connection DISCONNECTED");
            } else if (whatsappPc.iceConnectionState === 'failed') {
                console.error("WhatsApp ICE connection FAILED");
            } else if (whatsappPc.iceConnectionState === 'closed') {
                console.log("WhatsApp ICE connection CLOSED");
            }
        };

        // Create a promise to wait for WhatsApp audio track
        const waTrackPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                console.warn("Timed out waiting for WhatsApp track, continuing anyway");
                console.warn("Timeout occurred at:", new Date().toISOString());
                resolve(); // Resolve anyway to continue the process
            }, 5000);
            
            whatsappPc.ontrack = (event) => {
                clearTimeout(timeout);
                console.log("Audio track received from WhatsApp:", event.streams[0].id);
                console.log("WhatsApp track received at:", new Date().toISOString());
                console.log("WhatsApp track details - ID:", event.track.id);
                console.log("WhatsApp track details - Kind:", event.track.kind);
                console.log("WhatsApp track details - ReadyState:", event.track.readyState);
                console.log("WhatsApp track details - Enabled:", event.track.enabled);
                console.log("WhatsApp track details - Muted:", event.track.muted);
                whatsappStream = event.streams[0];
                resolve();
            };
        });

        // Ensure WhatsApp SDP offer includes a=setup:actpass
        let modifiedWhatsappSdp = whatsappOfferSdp;
        if (!modifiedWhatsappSdp.includes('a=setup:actpass')) {
            console.log("Adding a=setup:actpass to WhatsApp SDP offer");
            // Add a=setup:actpass after a=fingerprint line
            modifiedWhatsappSdp = modifiedWhatsappSdp.replace(
                /(a=fingerprint:.*)/g, 
                '$1\r\na=setup:actpass'
            );
            console.log("WhatsApp SDP modified to include a=setup:actpass");
        } else {
            console.log("WhatsApp SDP already contains a=setup:actpass");
        }
        
        await whatsappPc.setRemoteDescription(new RTCSessionDescription({
            type: "offer",
            sdp: modifiedWhatsappSdp
        }));
        console.log("WhatsApp offer SDP set as remote description.");

        // Create a high-quality dummy audio track if browser stream is empty
        if (!browserStream.getAudioTracks().length) {
            console.log("No browser audio tracks found, creating high-quality dummy track");
            const ctx = new (require('node-web-audio-api').AudioContext)({ sampleRate: 48000 });
            const oscillator = ctx.createOscillator();
            oscillator.frequency.value = 0; // Silent oscillator
            
            // Add gain to boost the signal
            const gainNode = ctx.createGain();
            gainNode.gain.value = 1.5; // Boost gain for better audio quality
            
            oscillator.connect(gainNode);
            const dest = ctx.createMediaStreamDestination();
            gainNode.connect(dest);
            oscillator.start();
            const dummyTrack = dest.stream.getAudioTracks()[0];
            
            // Set high bitrate constraints
            const constraints = {
                channelCount: 2,
                sampleRate: 48000,
                sampleSize: 24
            };
            
            browserStream.addTrack(dummyTrack);
        }

        // Forward browser mic to WhatsApp
        browserStream.getAudioTracks().forEach((track) => {
            console.log("Adding browser track to WhatsApp PC:", track.id);
            whatsappPc.addTrack(track, browserStream);
        });

        // Try to wait for WhatsApp audio but continue if it times out
        await waTrackPromise.catch(err => console.warn("WhatsApp track error:", err));

        // Forward WhatsApp audio to browser if available
        if (whatsappStream && whatsappStream.getAudioTracks().length > 0) {
            whatsappStream.getAudioTracks().forEach((track) => {
                console.log("Adding WhatsApp track to browser PC:", track.id);
                browserPc.addTrack(track, whatsappStream);
            });
        } else {
            console.warn("No WhatsApp audio tracks available to forward to browser");
        }

        // --- Create SDP answers for both peers ---
        const browserAnswer = await browserPc.createAnswer();
        await browserPc.setLocalDescription(browserAnswer);
        browserSocket.emit("browser-answer", browserAnswer.sdp);
        console.log("Browser answer SDP created and sent.");

        const waAnswer = await whatsappPc.createAnswer();
        await whatsappPc.setLocalDescription(waAnswer);
        
        // Format SDP for WhatsApp requirements
        let finalWaSdp = waAnswer.sdp;
        finalWaSdp = finalWaSdp.replace("a=setup:actpass", "a=setup:active");
        // Add a=ice-options:trickle if not present (helps with faster connection)
        if (!finalWaSdp.includes("a=ice-options:trickle")) {
            finalWaSdp = finalWaSdp.replace("a=group:BUNDLE 0", "a=group:BUNDLE 0\r\na=ice-options:trickle");
        }
        
        console.log("WhatsApp answer SDP prepared.");

        // Send pre-accept, and only proceed with accept if successful
        const preAcceptSuccess = await answerCallToWhatsApp(currentCallId, finalWaSdp, "pre_accept");

        if (preAcceptSuccess) {
            console.log("Pre-accept succeeded, proceeding to accept...");
            setTimeout(async () => {
                const acceptSuccess = await answerCallToWhatsApp(currentCallId, finalWaSdp, "accept");
                if (acceptSuccess && browserSocket) {
                    console.log("Accept succeeded, starting browser timer");
                    browserSocket.emit("start-browser-timer");
                } else {
                    console.error("Accept failed");
                }
            }, 1500); // Increased delay to give more time for setup
        } else {
            console.error("Pre-accept failed. Aborting accept step.");
            // Reset call in progress flag on failure
            callInProgress = false;
            console.log("Call in progress flag reset due to pre-accept failure");
        }

        // Don't reset session state immediately
        // Let the connections establish first
        setTimeout(() => {
            browserOfferSdp = null;
            whatsappOfferSdp = null;
        }, 5000);
    } catch (error) {
        console.error("Error in WebRTC bridge:", error);
        // Reset call in progress flag on error
        callInProgress = false;
        console.log("Call in progress flag reset due to WebRTC bridge error");
    }
}

/**
 * Sends "pre-accept" or "accept" response with SDP to WhatsApp API.
 */
async function answerCallToWhatsApp(callId, sdp, action) {
    const body = {
        messaging_product: "whatsapp",
        call_id: callId,
        action,
        session: { sdp_type: "answer", sdp },
    };

    console.log(`Sending ${action} to WhatsApp API for call ${callId}`);
    console.log(`SDP answer first 100 chars: ${sdp.substring(0, 100)}...`);

    try {
        console.log(`Making API request to ${WHATSAPP_API_URL}`);
        const response = await axios.post(WHATSAPP_API_URL, body, {
            headers: {
                Authorization: ACCESS_TOKEN,
                "Content-Type": "application/json",
            },
        });

        console.log(`WhatsApp ${action} API response:`, response.data);
        const success = response.data?.success === true;

        if (success) {
            console.log(`Successfully sent '${action}' to WhatsApp.`);
            return true;
        } else {
            console.warn(`WhatsApp '${action}' response was not successful.`);
            console.warn(`Response data:`, JSON.stringify(response.data));
            return false;
        }
    } catch (error) {
        console.error(`Failed to send '${action}' to WhatsApp:`, error.message);
        return false;
    }
}

/**
 * Terminate WhatsApp call.
 * Returns WhatsApp API response.
 */
 async function terminateCall(callId) {
    const body = {
        messaging_product: "whatsapp",
        call_id: callId,
        action: "terminate",
    };

    console.log(`Attempting to terminate call ${callId} at ${new Date().toISOString()}`);
    console.log(`API URL for termination: ${WHATSAPP_API_URL}`);
    console.log(`Termination request body: ${JSON.stringify(body)}`);

    try {
        const response = await axios.post(WHATSAPP_API_URL, body, {
            headers: {
                Authorization: ACCESS_TOKEN,
                "Content-Type": "application/json",
            },
        });

        const success = response.data?.success === true;
        console.log(`Terminate call response: ${JSON.stringify(response.data)}`);
        console.log(`Response status: ${response.status}`);
        console.log(`Response received at: ${new Date().toISOString()}`);

        if (success) {
            console.log(`Call ${callId} successfully terminated.`);
        } else {
            console.warn(`Call ${callId} terminate response was not successful.`);
        }

        return response.data;
    } catch (error) {
        console.error(`Failed to terminate call ${callId}:`, error.message);
        console.error(`Error details: ${JSON.stringify(error.response?.data || {})}`);
        return { success: false, error: error.message };
    }
}

/**
 * Initiate an outgoing call to a WhatsApp number directly.
 * This tries to make a call without checking permissions separately.
 */
async function initiateDirectCall(phoneNumber) {
    try {
        // Get the access token and phone number ID from environment variables
        const accessToken = process.env.ACCESS_TOKEN;
        const phoneNumberId = process.env.PHONE_NUMBER_ID;
        
        console.log(`Making direct call to ${phoneNumber}...`);
        console.log(`Call initiated at: ${new Date().toISOString()}`);
        console.log(`Using phone number ID: ${phoneNumberId}`);
        console.log(`Node.js memory usage: ${JSON.stringify(process.memoryUsage())}`);
        
        // Create an SDP offer for the outgoing call
        console.log("Creating WebRTC peer connection for outgoing call...");
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        console.log("Outgoing call PC created at:", new Date().toISOString());
        console.log("Outgoing call PC state:", pc.connectionState);
        console.log("Outgoing call PC ICE gathering state:", pc.iceGatheringState);
        console.log("Outgoing call PC signaling state:", pc.signalingState);
        
        // Add audio transceivers to ensure audio is included in the offer
        pc.addTransceiver('audio', { direction: 'sendrecv' });
        console.log("Added audio transceiver with sendrecv direction");
        
        // Create an SDP offer
       const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: false
        });
        console.log("SDP offer created successfully");
        console.log("SDP offer type:", offer.type);
        console.log("SDP offer first 100 chars:", offer.sdp.substring(0, 100) + "...");
        
        await pc.setLocalDescription(offer);
        console.log("Local description set on peer connection");
        
        // Wait for ICE gathering to complete or timeout after 5 seconds
        const sdpOffer = await Promise.race([
            new Promise((resolve) => {
                const checkState = () => {
                    if (pc.iceGatheringState === 'complete') {
                        resolve(pc.localDescription.sdp);
                    }
                };
                
                checkState();
                pc.onicegatheringstatechange = checkState;
            }),
            new Promise(resolve => {
                setTimeout(() => {
                    console.log("ICE gathering taking too long, using current SDP");
                    resolve(pc.localDescription.sdp);
                }, 5000);
            })
        ]);
        
        // Direct calling approach using the WhatsApp Cloud API
        console.log("Sending WhatsApp call API request at:", new Date().toISOString());
        console.log("API URL:", `https://graph.facebook.com/v19.0/${phoneNumberId}/calls`);
        console.log("SDP offer length:", sdpOffer.length);
        console.log("SDP offer first 100 chars:", sdpOffer.substring(0, 100) + "...");
        
        const response = await axios.post(
            `https://graph.facebook.com/v19.0/${phoneNumberId}/calls`,
            {
                messaging_product: "whatsapp",
                to: phoneNumber,
                action: "connect",
                session: {
                    sdp_type: "offer",
                    sdp: sdpOffer
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                }
            }
        );
        
        console.log("WhatsApp API response received at:", new Date().toISOString());
        console.log("Response status:", response.status);
        console.log("Response headers:", JSON.stringify(response.headers, null, 2));
        
        // Check if the call was initiated successfully
        if (response.data?.success === true || response.data?.id) {
            console.log("✅ Call initiated successfully:", response.data);
            return { 
                success: true, 
                call_id: response.data?.call_id || response.data?.id
            };
        } else {
            console.log("❌ Call initiation response:", response.data);
            return { 
                success: false, 
                error: "API returned unsuccessful response",
                data: response.data
            };
        }
    } catch (error) {
        console.error("❌ Error initiating direct WhatsApp call:", error.response?.data || error.message);
        console.error("Error occurred at:", new Date().toISOString());
        console.error("Error details:", JSON.stringify(error.response?.data || {}));
        console.error("Request URL:", error.config?.url);
        console.error("Request method:", error.config?.method);
        console.error("Request headers:", JSON.stringify(error.config?.headers || {}));
        
        // Check for specific error conditions
        const errorMsg = error.response?.data?.error?.message || error.message;
        const errorCode = error.response?.data?.error?.code;
        const timestamp = new Date().toISOString();
        
        console.error(`Error details at ${timestamp}:`, {
            errorCode,
            errorMessage: errorMsg,
            phoneNumber: phoneNumber,
            callAttemptTime: timestamp
        });
        
        // Handle specific error cases to provide better user feedback
        let userFriendlyError = errorMsg;
        let canRetry = false;
        
        if (errorMsg.includes("already ongoing") || errorMsg.includes("already in progress") || errorMsg.includes("busy")) {
            userFriendlyError = "The recipient is already on another call. Please try again later.";
            console.log(`Call to ${phoneNumber} failed: Recipient busy on another call`);
            // Cannot retry immediately when user is on another call
            canRetry = false;
        } else if (errorCode === 138010) {
            userFriendlyError = "Call rate limit reached. Please wait a moment before trying again.";
            console.log(`Call rate limit reached for ${phoneNumber}`);
            // Can retry after a delay when rate limited
            canRetry = true;
        } else if (errorCode === 138006) {
            userFriendlyError = "No approved call permission from recipient. Please request permission first.";
        }
        
        return { 
            success: false, 
            error: userFriendlyError,
            originalError: errorMsg,
            errorCode: errorCode,
            data: error.response?.data
        };
    }
}

/**
 * Initiate an outgoing call to a WhatsApp number.
 */
async function initiateWhatsAppCall(phoneNumber) {
    try {
        // Get the access token and phone number ID from environment variables
        const accessToken = process.env.ACCESS_TOKEN;
        const phoneNumberId = process.env.PHONE_NUMBER_ID;
        
        // Check permission status before attempting to call
        const permissionStatus = await checkCallPermission(phoneNumber);
        if (!permissionStatus.hasPermission) {
            console.log(`❌ No permission to call ${phoneNumber}. Status: ${permissionStatus.status}`);
            return { 
                success: false, 
                error: "No approved call permission from the recipient",
                permissionStatus: permissionStatus.status,
                data: { error: { code: 138006, message: "Call permission required" } }
            };
        }
        
        console.log(`✅ Permission confirmed for ${phoneNumber}. Initiating call...`);
        
        // Create an SDP offer for the outgoing call
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        
        // Add audio transceivers to ensure audio is included in the offer
        pc.addTransceiver('audio', { direction: 'sendrecv' });
        
        // Create an SDP offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        // Wait for ICE gathering to complete or timeout after 5 seconds
        const sdpOffer = await Promise.race([
            new Promise((resolve) => {
                const checkState = () => {
                    if (pc.iceGatheringState === 'complete') {
                        resolve(pc.localDescription.sdp);
                    }
                };
                
                checkState();
                pc.onicegatheringstatechange = checkState;
            }),
            new Promise(resolve => {
                setTimeout(() => {
                    console.log("ICE gathering taking too long, using current SDP");
                    resolve(pc.localDescription.sdp);
                }, 5000);
            })
        ]);
        
        console.log("Generated SDP offer for outgoing call");
        
        // Direct calling approach using the WhatsApp Cloud API
        const response = await axios.post(
            `https://graph.facebook.com/v19.0/${phoneNumberId}/calls`,
            {
                messaging_product: "whatsapp",
                to: phoneNumber,
                action: "connect",
                session: {
                    sdp_type: "offer",
                    sdp: sdpOffer
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                }
            }
        );
        
        // Check if the call was initiated successfully
        if (response.data?.success === true || response.data?.id) {
            console.log("✅ Call initiated successfully:", response.data);
            return { 
                success: true, 
                call_id: response.data?.call_id || response.data?.id
            };
        } else {
            console.log("❌ Call initiation response:", response.data);
            return { 
                success: false, 
                error: "API returned unsuccessful response",
                data: response.data
            };
        }
    } catch (error) {
        console.error("❌ Error initiating WhatsApp call:", error.response?.data || error.message);
        return { 
            success: false, 
            error: error.response?.data?.error?.message || error.message,
            data: error.response?.data
        };
    }
}

/**
 * Check if a user has granted permission for receiving calls
 * Uses the WhatsApp Cloud API to check permission status
 */
async function checkCallPermission(phoneNumber) {
    try {
        const accessToken = process.env.ACCESS_TOKEN;
        const phoneNumberId = process.env.PHONE_NUMBER_ID;
        
        console.log(`Attempting to check call permission for ${phoneNumber} directly...`);
        
        // Since the user_call_permissions endpoint is causing issues, try making a direct call
        // The WhatsApp API will reject the call if permission isn't granted
        // This is a workaround until we can figure out the correct API endpoint
        
        // Let's try to make a direct call with minimal SDP
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pc.addTransceiver('audio', { direction: 'sendrecv' });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        // Wait just long enough to get a valid SDP
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Create a test call to check permission - it will be a very short "probe" call
        try {
            const response = await axios.post(
                `https://graph.facebook.com/v19.0/${phoneNumberId}/calls`,
                {
                    messaging_product: "whatsapp",
                    to: phoneNumber,
                    action: "connect",
                    session: {
                        sdp_type: "offer",
                        sdp: pc.localDescription.sdp
                    }
                },
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    }
                }
            );
            
            // If the call is accepted, permission exists
            if (response.data?.success === true) {
                console.log(`✅ Permission check for ${phoneNumber}: GRANTED (call accepted)`);
                
                // Clean up the test call immediately
                if (response.data.call_id) {
                    try {
                        await axios.post(
                            `https://graph.facebook.com/v19.0/${phoneNumberId}/calls`,
                            {
                                messaging_product: "whatsapp",
                                call_id: response.data.call_id,
                                action: "terminate",
                            },
                            {
                                headers: {
                                    Authorization: `Bearer ${accessToken}`,
                                    'Content-Type': 'application/json',
                                }
                            }
                        );
                        console.log("Test call terminated successfully");
                    } catch (terminateError) {
                        console.error("Error terminating test call:", terminateError.message);
                    }
                }
                
                return {
                    hasPermission: true,
                    status: "granted",
                    data: response.data
                };
            }
            
            console.log(`❓ Unexpected response from call probe:`, response.data);
            return {
                hasPermission: false, 
                status: "unknown",
                data: response.data
            };
        } catch (error) {
            // If we get error code 138006 specifically, it means no permission
            if (error.response?.data?.error?.code === 138006) {
                console.log(`❌ Permission check for ${phoneNumber}: NOT GRANTED (code 138006)`);
                return {
                    hasPermission: false,
                    status: "denied",
                    error: error.response.data.error.message
                };
            }
            
            // For other errors, we can't determine the permission status
            console.error("Error during permission probe call:", error.response?.data || error.message);
            return {
                hasPermission: false,
                status: "error",
                error: error.response?.data?.error?.message || error.message
            };
        } finally {
            // Clean up WebRTC resources
            pc.close();
        }
    } catch (error) {
        console.error("Error checking call permission:", error.response?.data || error.message);
        // If we can't check permission, assume no permission
        return {
            hasPermission: false,
            status: "error",
            error: error.response?.data?.error?.message || error.message
        };
    }
}

/**
 * Send a call permission request to the user
 * This sends an interactive message with a permission request
 */
async function sendCallPermissionRequest(phoneNumber) {
    try {
        const accessToken = process.env.ACCESS_TOKEN;
        const phoneNumberId = process.env.PHONE_NUMBER_ID;
        
        // Prepare the permission request message
        const response = await axios.post(
            `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
            {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: phoneNumber,
                type: "interactive",
                interactive: {
                    type: "call_permission_request",
                    body: {
                        text: "Would you like to receive calls from our application? This will allow us to provide better service through voice calls."
                    },
                    action: {
                        name: "call_permission_request"
                    }
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                }
            }
        );
        
        console.log("Call permission request sent:", response.data);
        
        return {
            success: true,
            messageId: response.data?.messages?.[0]?.id,
            data: response.data
        };
    } catch (error) {
        // Extract the error data for better debugging
        const errorData = error.response?.data || {};
        console.error("Error sending call permission request:", errorData);
        
        // Handle rate limit errors specifically
        if (errorData?.error?.code === 138009) {
            console.log("Rate limit reached for permission requests to this number");
            return {
                success: false,
                error: "Rate limit reached for permission requests to this number. WhatsApp allows only one permission request every 24 hours.",
                errorCode: errorData?.error?.code,
                errorData: errorData,
                retryAfter: "24 hours" // WhatsApp typically enforces a 24-hour cooling period
            };
        }
        
        return {
            success: false,
            error: errorData?.error?.message || error.message,
            errorCode: errorData?.error?.code,
            errorData: errorData
        };
    }
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
