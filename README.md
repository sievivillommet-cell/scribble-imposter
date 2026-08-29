# Scribble Imposter – Multiplayer

Statische Multiplayer-Webapp mit Supabase (Auth, Postgres und Realtime). Kann direkt auf Vercel gehostet werden.

## Setup in 5 Schritten

1. Auf https://supabase.com ein kostenloses Projekt erstellen.
2. In Supabase unter **Authentication → Providers / Sign In → Anonymous** anonyme Logins aktivieren.
3. Im **SQL Editor** den kompletten Inhalt von `schema.sql` ausführen.
4. Unter **Project Settings / API** die Project URL und den **Publishable Key** kopieren und in `config.js` eintragen. Niemals den `service_role` Key verwenden.
5. Den ganzen Ordner bei Vercel importieren/deployen (oder auf GitHub pushen und das Repo in Vercel importieren).

Danach öffnen alle dieselbe Vercel-URL. Der Host erstellt einen Raum und teilt den sechsstelligen Raumcode.

## Spielablauf

- Host: Name eingeben → Raum erstellen.
- Freunde: Name + Raumcode → Beitreten.
- Host startet ab 3 Spielern.
- Jeder Browser sieht nur die eigene Rolle. Der Imposter sieht nur die Kategorie.
- Es gibt 3 Runden. Jeder Spieler zeichnet pro Zug genau eine Linie.
- Die aktive Linie wird via Realtime Broadcast live an die anderen Browser geschickt und nach Abschluss in Postgres gespeichert.
- Danach stimmt jeder Spieler auf seinem eigenen Gerät ab.
- Bei Gleichstand oder falscher Wahl gewinnt der Imposter.
- Wird der Imposter gewählt, darf nur dieser das Wort raten. Richtige Antwort = Imposter-Sieg, falsche Antwort = Zeichner-Sieg.

## Hinweise

- Diese Version ist für private Freundesrunden gedacht, nicht für öffentliche, große Lobbys.
- Namen sind auf 24 Zeichen begrenzt.
- Räume werden aktuell nicht automatisch gelöscht. Für private Nutzung ist das unproblematisch; später kann ein Cleanup ergänzt werden.
- Wenn Realtime nicht reagiert, prüfen, ob `rooms`, `players` und `strokes` in Supabase unter Realtime/Replication aktiviert sind. `schema.sql` versucht das automatisch.
