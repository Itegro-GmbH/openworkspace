# Mail-Archiv (Journal) und Verfahrensdokumentation

Stand: Entwurf, nach bestem Wissen ohne Rechtsberatung. Bitte vom Steuerberater
bzw. Datenschutzbeauftragten gegengelesen werden lassen.

## 1. Was das Archiv tut

Jede eingehende und jede ausgehende Mail wird automatisch als Original-`.eml`
in einen **separaten R2-Bucket** (`itegro-mail-archive`, EU-Jurisdiktion)
kopiert. Der Bucket ist per **Bucket Lock** gegen Löschen und Überschreiben
geschützt (Aufbewahrungsfrist 7 Jahre).

Wichtig: Das Archiv ist **fail-open**. Fällt es aus, werden Mails trotzdem
normal empfangen und gesendet. Ein Fehler wird in der Datenbank
(`mail_archive_entries`) festgehalten und im Admin-Dashboard angezeigt.

- Eingehend: Kopie der Rohmail direkt beim Empfang.
- Ausgehend: Nach erfolgreicher Übergabe an Cloudflare Email Sending wird die
  Mail aus den gesendeten Daten rekonstruiert (RFC 5322). Das ist eine
  Wiedergabe, nicht der exakte MIME-Strom des Versanddienstes.
- Schlägt etwas fehl, versucht ein Cron-Job (alle 10 Minuten) es mit Backoff
  erneut. Im Dashboard gibt es zusätzlich den Button **Archive now**.
- Der Cron gleicht außerdem den Mail-Speicher mit dem Journal ab und
  archiviert rückwirkend alles, was fehlt.
- Rohkopien, die noch nicht archiviert sind, werden vom Löschjob **nicht**
  gelöscht, sondern später erneut geprüft.

## 2. Einrichtung (vor dem Merge auf master!)

Der Bucket muss existieren, bevor der Branch deployt wird, sonst schlägt der
Deploy fehl.

1. Bucket anlegen (EU-Jurisdiktion, muss bei Erstellung gesetzt werden):
   ```
   bunx wrangler r2 bucket create itegro-mail-archive --jurisdiction eu
   ```
2. Aufbewahrungssperre (7 Jahre = 2555 Tage) setzen:
   ```
   bunx wrangler r2 bucket lock add itegro-mail-archive \
     --name mail-retention --prefix "" --retention-days 2555
   ```
   Die genauen Flags ggf. mit `bunx wrangler r2 bucket lock add --help`
   prüfen. Alternativ im Dashboard: R2 → Bucket → Settings → Bucket lock rules
   → Age: 7 Jahre.
3. Optional: Lifecycle-Regel, die Objekte nach Ablauf (z. B. 7 Jahre + 30 Tage)
   löscht.
4. Cloudflare-Konto absichern: 2FA für alle Admins, möglichst wenige
   Account-Admins, API-Tokens ohne R2-Admin-Rechte für den Alltag.
5. Branch mergen, Deploy abwarten, im Admin-Dashboard (Mailboxes-Ansicht)
   prüfen, dass das Archiv-Panel „Healthy" zeigt.

Hinweis: Solange Lock-Regeln existieren, kann der Bucket nicht geleert werden.
Das ist gewollt.

## 3. Betrieb

- Dashboard → Mailboxes → Panel „Mail archive": Zähler (archiviert, wartend,
  fehlgeschlagen), offene Einträge mit Fehlertext, Button „Archive now".
- Regelmäßig (z. B. quartalsweise) eine Stichprobe: eine Mail aus dem Archiv
  lesen und mit dem Postfach vergleichen.
- Exportieren: Objekte per R2-Dashboard oder `wrangler r2 object get` abrufen.
  Schlüsselschema: `JJJJ/MM/incoming|outgoing/<id>.eml`.

## 4. Grenzen / Restrisiken

- Wird eine Mail endgültig gelöscht, bevor sie archiviert wurde, kann sie nicht
  rekonstruiert werden (bei eingehenden Mails verhindert der Löschjob das, bei
  ausgehenden gilt das nur über den Cron-Abgleich).
- Ausgehende Archivkopien sind Rekonstruktionen (siehe oben).
- Wer das Cloudflare-Konto übernimmt, könnte Lock-Regeln ändern. Daher 2FA und
  wenige Admins; optional zweite Sicherung bei einem anderen Anbieter.
- Der Cron läuft alle 10 Minuten, ein Ausfall fällt also spätestens dann auf.

## 5. Entwurf Verfahrensdokumentation (E-Mail)

**Geltungsbereich:** geschäftliche E-Mail-Postfächer der Itegro GmbH
(itegro-gmbh.de, webspired.de). Rechnungen werden getrennt aufbewahrt und
unterliegen eigenen Regeln; dieses Dokument betrifft die übrige geschäftliche
Korrespondenz (Handelsbriefe, § 257 HGB, 6 Jahre ab Ende des Kalenderjahres).

**Verantwortlich:** Geschäftsführung. Technische Betreuung: <Name eintragen>.

**Eingang:** Mails kommen über Cloudflare Email Routing (bzw. Weiterleitung
von IONOS an eine generierte Weiterleitungsadresse) in OpenWorkspace an. Die
Rohmail wird unverändert gespeichert und zusätzlich in das Archiv kopiert.

**Ausgang:** Mails werden über OpenWorkspace und Cloudflare Email Sending
versendet. Nach erfolgreichem Versand wird eine Kopie im Archiv abgelegt.

**Unveränderbarkeit:** Archivobjekte werden nie überschrieben; Bucket Lock
verhindert Löschen und Überschreiben innerhalb der Frist. Zu jedem Objekt
werden SHA-256-Prüfsumme und Zeitpunkt gespeichert.

**Auffindbarkeit und Lesbarkeit:** Schlüssel nach Jahr/Monat/Richtung/ID;
Zuordnung zum Postfach über die Datenbank (`mail_archive_entries`). Format
`.eml` (RFC 5322) ist mit gängigen Mailprogrammen lesbar.

**Kontrolle:** Das Admin-Dashboard zeigt den Archivstatus. Fehler werden
automatisch wiederholt und können manuell angestoßen werden. Stichproben
quartalsweise, Ergebnis dokumentieren.

**Aufbewahrung und Löschung:** 7 Jahre Sperrfrist, danach Löschung per
Lifecycle-Regel, sofern keine Aufbewahrungspflicht oder Rechtsstreit entgegen-
steht.

**Datenschutz:** Auftragsverarbeitungsvertrag mit Cloudflare abschließen
(DPA, EU-Jurisdiktion für R2, Data Privacy Framework). Verarbeitung im
Verzeichnis der Verarbeitungstätigkeiten aufnehmen. Private Nutzung der
Postfächer ist untersagt (sonst Fernmeldegeheimnis-Fragen), Mitarbeiter
entsprechend informieren.

**Geschäftsbriefangaben:** Pflichtangaben nach § 35a GmbHG in der
E-Mail-Signatur (Firma, Rechtsform, Sitz, Registergericht und -nummer,
Geschäftsführer).

**Offene Punkte zur Klärung mit dem Steuerberater:** Reicht die
Rekonstruktion ausgehender Mails als Wiedergabe? Ist die gewählte
Aufbewahrungsdauer passend? Gibt es Mails mit Rechnungscharakter, die in den
separaten Rechnungsprozess gehören?
