# Google Flights Starlink Indicator

Chrome extension that highlights flights with Starlink WiFi on Google Flights.

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `chrome-extension` folder
5. Visit [Google Flights](https://www.google.com/flights) and search for flights

## Features

- Automatically detects flights with Starlink WiFi
- Shows "✈️ Starlink" badge on equipped flights
- Desktop: Badge appears inline after flight times
- Tablet/Mobile: Subtle badge in top-left corner

## How it Works

The extension queries unitedstarlinktracker.com to check if a flight's aircraft has Starlink installed, then adds a visual indicator to matching flights on Google Flights search results.

## Privacy Policy

This extension:
- Only reads flight numbers from Google Flights pages you visit
- Sends flight numbers to unitedstarlinktracker.com to check Starlink availability
- Does not collect or store any personal information
- Does not track your browsing history
- Caches flight data locally for 30 minutes to reduce API requests
- All data processing happens locally in your browser