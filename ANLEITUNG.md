# DocScan – Einrichtung

Dokumente mit der Handykamera scannen (mehrere Seiten), automatisch zuschneiden,
per Texterkennung benennen und als PDF direkt in einen Google-Drive-Ordner hochladen.

## 1. App auf GitHub Pages veröffentlichen

1. Auf github.com ein neues Repository anlegen, z. B. `docscan` (Public).
2. Alle Dateien aus diesem Ordner hochladen („Add file → Upload files“).
3. Repository → **Settings → Pages** → Source: „Deploy from a branch“, Branch `main`, Ordner `/ (root)` → Save.
4. Nach ca. 1 Minute ist die App erreichbar unter
   `https://DEIN-GITHUB-NAME.github.io/docscan/`

## 2. Google-Drive-Zugang einrichten (einmalig, kostenlos)

1. https://console.cloud.google.com öffnen → oben neues Projekt „DocScan“ anlegen.
2. **APIs & Dienste → Bibliothek** → „Google Drive API“ suchen → **Aktivieren**.
3. **Google Auth Platform → Branding**: App-Name „DocScan“, deine Mail als Support-Mail.
   Zielgruppe: **Extern**, Status bleibt **Testen**.
4. **Zielgruppe → Testnutzer** → deine eigene Google-Adresse hinzufügen.
5. **Clients → Client erstellen** → Typ **Webanwendung** →
   **Autorisierte JavaScript-Quellen**: `https://DEIN-GITHUB-NAME.github.io`
   (ohne `/docscan` am Ende – die genaue Adresse zeigt die App auch unter ⚙ Einstellungen an).
6. Die angezeigte **Client-ID** (`….apps.googleusercontent.com`) kopieren und
   - entweder in `config.js` eintragen (dann auf GitHub neu hochladen),
   - oder in der App unter ⚙ Einstellungen einfügen.

Beim ersten Anmelden zeigt Google „Diese App wurde nicht überprüft“ –
das ist normal, weil es deine private App ist: **Erweitert → Weiter zu DocScan**.

## 3. Auf dem Android-Handy installieren

1. Die GitHub-Pages-Adresse in **Chrome** öffnen.
2. Menü **⋮ → App installieren** (bzw. „Zum Startbildschirm hinzufügen“).
3. App öffnen, Kamera erlauben – fertig.

## Bedienung

- **Neuer Scan** → Dokument hinlegen. Grüner Rahmen = Dokument erkannt.
- **Auto** an: Liegt das Dokument ruhig, wird automatisch ausgelöst. Danach einfach
  die nächste Seite hinlegen – so viele Seiten wie nötig.
- Auf ein Vorschaubild tippen → Ecken korrigieren, drehen, Filter, löschen.
- **Fertig** → Name wird per Texterkennung vorgeschlagen
  (z. B. `2026-10-14_Rechnung_Telekom-Deutschland`), Ordner wählen → **Hochladen**.
- Benutzte Ordner werden als Favoriten gemerkt. Heißt ein Ordner z. B. „Rechnungen“,
  wird er bei einer erkannten Rechnung automatisch vorgeschlagen.
  (Favorit lange drücken → entfernen.)

Die Texterkennung läuft komplett auf dem Handy – es geht nichts an fremde Server
außer der fertigen PDF an dein Google Drive.
