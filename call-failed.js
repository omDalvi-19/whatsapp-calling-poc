// This is the improved call-failed handler
socket.on("call-failed", (error) => {
  console.error("Call failed:", error);
  
  // Create more detailed error message in the call status area
  if (error.includes("already on another call") || error.includes("busy")) {
    console.log("Error type: Already on another call");
    
    // Instead of alert, show in the status area
    callStatusMessage.innerHTML = "❌ <strong>Call Failed:</strong> The recipient is currently on another call. Please try again later.";
    callStatusMessage.style.color = "#e91e63";
    
    // Add a retry button that appears after 30 seconds
    setTimeout(() => {
      if (currentPhoneNumber) {
        const retryButton = document.createElement("button");
        retryButton.textContent = "Retry Call";
        retryButton.style.backgroundColor = "#ff9800";
        retryButton.style.color = "white";
        retryButton.style.border = "none";
        retryButton.style.padding = "8px 16px";
        retryButton.style.borderRadius = "4px";
        retryButton.style.marginTop = "10px";
        retryButton.style.cursor = "pointer";
        
        retryButton.onclick = () => {
          callStatusMessage.innerHTML = "Retrying call...";
          retryButton.remove();
          
          // Try the call again
          makeCallBtn.click();
        };
        
        callStatusMessage.appendChild(document.createElement("br"));
        callStatusMessage.appendChild(retryButton);
      }
    }, 30000); // Wait 30 seconds before showing retry option
    
  } else if (error.includes("rate limit") || error.includes("Limit reached")) {
    console.log("Error type: Rate limit");
    callStatusMessage.innerHTML = "⚠️ <strong>Rate Limit:</strong> You've reached the rate limit for calls or permission requests. Please try again in a few minutes.";
    callStatusMessage.style.color = "#ff9800";
  } else if (error.includes("permission")) {
    console.log("Error type: Permission issue");
    callStatusMessage.innerHTML = "⚠️ <strong>Permission Required:</strong> " + error;
    callStatusMessage.style.color = "#2196f3";
  } else {
    console.log("Error type: Other");
    callStatusMessage.innerHTML = "❌ <strong>Call Failed:</strong> " + error;
    callStatusMessage.style.color = "#dc3545";
  }
  
  makeCallBtn.disabled = false;
  makeCallBtn.textContent = "Make Call";
  makeCallBtn.style.backgroundColor = "#25D366";
  callStatusEl.textContent = "";
});
