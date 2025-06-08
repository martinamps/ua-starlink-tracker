# United Airlines Starlink Tracker

Chrome extension that highlights United Airlines flights with Starlink WiFi on Google Flights.

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `chrome-extension` folder
5. Visit [Google Flights](https://www.google.com/flights) and search for United flights

## Features

- Automatically detects United flights with Starlink WiFi
- Shows "✈️ Starlink" badge on equipped flights
- Desktop: Badge appears inline after flight times
- Tablet/Mobile: Subtle badge in top-left corner

## How it Works

The extension queries unitedstarlinktracker.com to check if a flight's aircraft has Starlink installed, then adds a visual indicator to matching flights on Google Flights search results.