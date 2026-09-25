# FootballAI FINAL

## Was enthalten ist

FootballAI ist jetzt als zusammenhängende Web/PWA-Projektbasis aufgebaut:

- Responsive Fußball-Web-App
- PWA-Grundlage für Mobilgeräte
- API-Football-Anbindung
- Fixtures / Spiele
- Teamform
- Heim-/Auswärtsgewichtung
- Poisson-Wahrscheinlichkeiten
- Verletzungen / Verfügbarkeit
- Aufstellungsprüfung
- Bet365-Quote als bevorzugter Bookmaker, sofern über den konfigurierten Datenweg vorhanden
- automatische Edge-Berechnung
- Live Auto-Scanner
- `NO BET`, wenn die Schwellenwerte nicht erreicht werden
- Historie
- Backtest-Settlement und Metriken
- Docker-Startoption
- API-Schlüssel ausschließlich serverseitig

## Wichtig zur Datenversorgung

API-Football dokumentiert Fixtures, Lineups, Verletzungen, Statistiken, Vorhersagen und Pre-Match-Quoten. Die Datenabdeckung unterscheidet sich je Wettbewerb und Saison; vor dem Abruf sollte die Coverage geprüft werden.

Bet365 stellt keine öffentliche Developer-Odds-API bereit. Deshalb wird kein bet365-Scraping und kein Login-Automatisierungsmechanismus eingebaut. Das Projekt nutzt nur Quoten, die über einen zulässigen Datenprovider geliefert werden. Wenn dort keine Bet365-Quote verfügbar ist, wird das Spiel übersprungen und es wird kein Preis erfunden.

## Start lokal

### 1. Server

Node.js 20+:

```bash
cd server
cp .env.example .env
# FOOTBALL_API_KEY eintragen
npm install
npm start
```

### 2. Web

In einem zweiten Terminal:

```bash
cd web
python3 -m http.server 8080
```

Dann:

`http://localhost:8080`

### Docker

```bash
cp server/.env.example server/.env
# Schlüssel eintragen
docker compose up
```

## Modelllogik

Das aktuelle Modell ist absichtlich nachvollziehbar:

1. letzte abgeschlossene Spiele
2. Gesamtform + Heim-/Auswärtsform
3. erwartete Tore für beide Teams
4. Poisson-Verteilung
5. Markt-Wahrscheinlichkeit
6. implizite Wahrscheinlichkeit der Quote
7. Edge = Modellwahrscheinlichkeit - implizite Quote
8. nur bei Mindestwahrscheinlichkeit + Mindest-Edge wird ein Kandidat angezeigt

Das ist eine solide technische Basis, aber noch kein wissenschaftlich validiertes Profitversprechen.

## Backtesting

Für ein seriöses Backtesting muss jede historische Analyse ausschließlich Daten verwenden, die zum damaligen Zeitpunkt bereits verfügbar waren. Besonders wichtig:

- historische Quoten-Snapshots
- historische Aufstellungen
- Verletzungsstand zum damaligen Zeitpunkt
- keine Daten-Leaks aus späteren Spielen
- Walk-forward statt zufälligem Train/Test-Split
- Brier Score / Log Loss für Kalibrierung
- ROI und Trefferquote
- Closing-Line-Value
- Drawdown
- Konfidenzintervalle

Die API-Football-Odds-Historie ist begrenzt; für belastbares Langzeit-Backtesting müssen Quoten-Snapshots deshalb laufend gespeichert oder von einem Provider mit historischer Datenhaltung bezogen werden.

## Was noch benötigt wird, bevor es öffentlich live gehen sollte

1. API-Football-Key
2. lizenzierter Quoten-Datenzugang mit gewünschter Bet365-Abdeckung
3. Domain + HTTPS
4. Datenbank statt JSON-Datei für Produktion
5. Login / Benutzerverwaltung
6. Push-Notifications
7. Monitoring und Error-Logging
8. rechtliche Prüfung für die Zielregion und Wett-/Glücksspielwerbung
9. Alters-/Responsible-Gambling-Hinweise, soweit erforderlich
10. echte historische Backtest-Daten und Modellkalibrierung

## 99%-Thema

FootballAI darf niemals eine 99%-Gewinngarantie behaupten. Eine hohe Modellwahrscheinlichkeit ist eine statistische Schätzung und keine sichere Wette. Der wichtigste Sicherheitsmechanismus ist deshalb `NO BET`, wenn Datenqualität oder Edge nicht ausreichen.

## Mobile App

Die PWA kann auf einem Smartphone installiert werden. Eine echte iOS/Android-App kann anschließend mit Expo/React Native auf dieselbe Backend-API gesetzt werden, ohne die Modelllogik doppelt zu bauen.

## Architektur

```text
iOS / Android / Web PWA
          |
          v
     FootballAI API
          |
   +------+------+
   |             |
Football Data   Odds Provider
   |             |
   +------+------+
          |
     Model Engine
          |
  Probability / Edge
          |
      NO BET / Candidate
          |
     History / Backtest
```

Keine automatische Wettabgabe ist eingebaut.
