# FootballAI als installierbare Android-PWA

Diese Version basiert unverändert auf `FootballAI_FINAL` und enthält zusätzlich:
- Web App Manifest
- App-Icons
- Service Worker / Offline-Grundfunktion
- Android-Standalone-Modus

## Installation auf Android

Die Web-App muss über eine **HTTPS-Adresse** aufgerufen werden (z. B. über GitHub Pages, Netlify oder Vercel).

Auf dem Android-Handy:
1. Die HTTPS-Adresse in Chrome öffnen.
2. Im Chrome-Menü **„App installieren“** oder **„Zum Startbildschirm hinzufügen“** wählen.
3. FootballAI erscheint anschließend als App-Symbol.

## Wichtig

Die PWA ist die Oberfläche. Für Live-Fußballdaten, Scanner und Quoten muss das FootballAI-Backend weiterhin online erreichbar sein und korrekt konfiguriert werden.
