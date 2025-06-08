chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "checkFlight") {
    const { flightNumber, date } = request;
    const url = `https://unitedstarlinktracker.com/api/check-flight?flight_number=${flightNumber}&date=${date}`;

    console.log("[Starlink Tracker Background] Fetching:", url);

    fetch(url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        console.log("[Starlink Tracker Background] API response:", data);
        sendResponse({ success: true, data });
      })
      .catch((error) => {
        console.error("[Starlink Tracker Background] API error:", error);
        sendResponse({ success: false, error: error.message });
      });

    return true;
  }
});
