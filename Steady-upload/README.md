# Steady

**Small steps. Every day.**

Steady is a private, single-user habit tracker and journal. It runs on your Windows computer and stores its data in SQLite. You can check off daily habits, write a guided reflection or a free entry, record a mood, review previous days, and follow a 14-day consistency challenge.

## Install on Windows

1. Install the latest **Node.js 24 LTS** Windows release. Steady requires Node.js 24.8 or later for SQLite and Argon2id. Close and reopen VS Code after installing. [Node.js downloads](https://nodejs.org/en/download)
2. In VS Code, choose **File → Open Folder** and open the Steady folder that contains `package.json`.
3. Choose **Terminal → New Terminal**. In PowerShell, check that `node --version` starts with `v24` or later.
4. Install dependencies and start the application.

   ```powershell
   npm ci
   npm start
   ```

   If PowerShell blocks npm's script shim, use `npm.cmd ci` and `npm.cmd start`. Installation needs access to the npm registry. After installation, the app and its bundled Bootstrap styling run without internet access.

5. Open [http://127.0.0.1:3001](http://127.0.0.1:3001) and create a master password of at least 12 characters. Keep it somewhere safe.
   Use the eye button inside each password field to check what you entered before confirming. If too many login attempts fail, Steady shows how much time remains before another attempt is allowed.
6. To stop the server, press **Ctrl+C** in its terminal. Run `npm start` again to reopen the same database. Use `npm run dev` for a server that restarts on source edits. A server restart requires unlocking again.

## Use Steady

- **Today** is the daily check-in. Tick or clear a habit, select a mood, and write in the optional Quick Reflection. It autosaves in one encrypted entry per date. Browse dates with **Previous day**, **Next day**, or **Today**. Use **+ New Note** for standalone writing.
- **Notes** stores standalone writing with an optional event date. Browse by recently edited, search, or open a note to edit it. **Focus Writing** keeps your draft in place while hiding secondary controls. Use **Escape** to exit.
- **History** searches daily reflections, monthly reflections, and notes above the Monday-first calendar. Press **/** outside a text field to focus search. Try text, a day number, a date such as **23 Nov 2026**, or a month and year. Select a date to review its check-in and edit its reflection.
- **Monthly** has one optional encrypted writing area per Singapore calendar month. Browse earlier months to reopen and edit them.
- Edits autosave after about a second. Wait for **Saved** before closing the browser. Use **Retry** after a failed save or press **Ctrl+Enter** to save. If Steady locks with unsaved changes, leave the tab open, unlock in another tab using the link, then retry from the original tab. If an entry changed elsewhere, copy your unsaved text before reloading the latest version.
- **Statistics**, accessible from History, shows Monday–Sunday habit and mood activity and compares equivalent periods when both have records. Earlier rates, streaks and the 14-day challenge remain available. Restarting a challenge starts a new window today.
- **Settings** manages habit definitions, order, timezone, lock duration, and the reminder preference. Steady stores your preferred reminder time for reference. Device alarms can provide notifications independently.
- **Lock now** clears the active key from the server session. The server also locks after 15 minutes of inactivity by default.

## How dates and statistics work

Steady defaults to **Asia/Singapore** and uses local calendar dates in the configured timezone. It snapshots each day's scheduled habits, including their names, descriptions, duration and order. Habit changes take effect the next time a new local date is recorded. After a gap between visits, Steady fills in the elapsed days with the schedule that was in effect when you last left. Timezone changes affect which date is current while existing snapshots retain their original dates.

Choose **Daily**, **Specific weekdays**, or **Days per week** in a habit’s settings. Log weekly targets under **Weekly goals** and rest-day completions under **Optional activity**. A new weekly goal can start today when there is no plan for that habit on today’s date. Weekly and other optional completions count in weekly totals and stay outside the daily completion rate. A weekly goal uses the first target recorded for that habit in the Monday–Sunday week, so midweek edits update the goal from the next week. Disabling a habit preserves its past records.

Overall completion rates divide fully completed days by tracked days that had at least one scheduled habit. They include today when it has scheduled habits. The weekly chart and the dashboard use the share of each day's scheduled habits completed. Individual rates divide completions by the days that habit was scheduled. A historical date with no scheduled habits cannot count as fully complete, and a gap in scheduled dates interrupts a consecutive-calendar-day streak. An unfinished today leaves yesterday's streak intact. Future dates are excluded. The challenge counts fully completed days within its inclusive 14-day window.

## Storage, backups and moving computers

The default database is `data/steady.sqlite` inside the Steady folder. SQLite may also create `steady.sqlite-wal` and `steady.sqlite-shm` beside it. The data directory is outside the public assets directory and ignored by Git. For a separate private location, set `$env:STEADY_DATA_DIR = 'C:\Users\YourName\SteadyData'` in the terminal before starting. Run a single server per database and keep the data directory under your own Windows account.

### Create an encrypted backup

1. Unlock Steady and open **Settings → Data and backups → Create encrypted backup**.
2. Enter your master password and choose a backup password of at least 12 characters.
3. Download the `.steady` file. Keep it and its password in separate safe places. The backup password stays the same even if you later change your master password.

The backup includes habit definitions and schedules, historical plans, completions, encrypted daily and monthly reflections, Personal Notes, moods, challenges, and preferences. It excludes sessions, local backup status, and master-password credentials. The encrypted envelope remains `steady-backup-v1`. It contains a 16-byte salt encoded in hex and a Base64 payload with a 12-byte nonce, a 16-byte authentication tag and ciphertext. Steady derives the backup key separately with Argon2id using 64 MiB memory, three passes, and one lane. AES-256-GCM authenticates the collection and protects the included source journal key. Phase 4 writes payload version 4 and restores versions 1 through 4. Older backups with weekly writing preserve it as Notes on restore. Older builds require an upgrade to restore new backups. Backup files are capped at 64 MiB.

Settings shows the last successful server-side generation and an optional reminder after 7, 14, or 30 days. The default is 14 days. Check your Downloads or backup location to confirm you kept the encrypted file.

Schema migration 002 adds schedule, historical plan, optional completion, and monthly reflection tables. It copies existing daily snapshots into historical plans and preserves the original rows and credentials.
Schema migration 003 adds the weekly reflection table. Existing journal and monthly reflection ciphertext does not change.
Schema migration 004 adds Personal Notes and removes the weekly writing table after checking it is empty. On the first authenticated visit, Steady uses the unlocked key to copy longer entries into Notes and convert guided writing. It verifies the converted records in the same transaction. The original encrypted journal rows remain as archives. The unified search shows up to 75 matches and may ask for a narrower query.

### Restore or move to a new computer

1. Make an encrypted backup on the original computer and transfer it with the Steady source files. Transfer the backup password separately.
2. Install Node.js, run `npm ci` and `npm start` on the new computer, and create a master password during setup.
3. Open **Settings → Data and backups → Restore encrypted backup**. Choose the file, enter the destination master password and the original backup password, and confirm replacement.
4. Verify your habits and journal. The destination master password continues to unlock Steady. Restoration validates and re-encrypts journal entries for the destination and replaces records in one SQLite transaction. Failed validation rolls back the replacement.

For a readable export, use **Export journal as Markdown** and re-enter your master password. The download contains plaintext. Steady sends it directly to your browser without creating an intermediate disk file.

## How password protection works

Steady binds to `127.0.0.1`. Helmet sets security headers, write requests require a CSRF token, and repeated invalid passwords are rate-limited. Session metadata is persisted in SQLite with HttpOnly, SameSite=Strict cookies. Optional local HTTPS uses Secure cookies. To enable it, set `STEADY_TLS_CERT` and `STEADY_TLS_KEY` to paths for a trusted local certificate and its private key, then open the printed HTTPS URL.

The master password is verified against an Argon2id hash with a random salt using a timing-safe comparison. A separate salt and Argon2id derivation produce the key that wraps a random 256-bit journal data key. Entries use AES-256-GCM with a fresh 96-bit nonce and a 128-bit authentication tag. Entry ID, date, mode, timestamps and revision are authenticated with the ciphertext. Titles and writing are encrypted, while dates, habits, moods, and other tracking metadata are visible to someone with direct database access. [Node.js cryptography documentation](https://nodejs.org/docs/latest-v24.x/api/crypto.html)

The unwrapped journal key lives in a server-memory buffer for each unlocked session. Steady clears buffers on lock, expiration and clean shutdown where practical. Decrypted text and password strings can also exist transiently in JavaScript and browser memory, which cannot be reliably wiped. Search decrypts matching-date records in memory and has no plaintext index. Journal drafts live in the page and are saved to the server. Closing a tab, browser, or computer before a save succeeds can lose unsaved text.

Changing the master password rewraps the same journal key in a transaction. There is no password reset. If you forget the master password, the journal may be permanently inaccessible unless you have a separate encrypted backup and its password. Encryption addresses access to stored journal data. Malware, a compromised operating system, and anyone with access to an unlocked screen can still read it.

## Tests and files

Run `npm test` or `npm.cmd test`. The test suites use temporary SQLite databases and synthetic journal content. They cover authentication, real HTTP session handling, CSRF, tracking, local date boundaries, autosave, encryption and atomic backup restoration. `node --test tests/model.test.js tests/draft.test.js tests/local-server.test.js` runs the core and loopback suites without npm dependencies.

| Path | Purpose |
| --- | --- |
| `app.js` | Server startup, page routes and authenticated HTTP API |
| `middleware/` | Persistent sessions, idle locking and password rate limiting |
| `models/` | SQLite queries, tracking rules, journal revisions and backup validation |
| `services/` | Calendar and cryptographic primitives |
| `database/migrations/` | Versioned SQLite schema |
| `views/` and `public/` | EJS pages, styles and browser interactions |
| `tests/` | Automated core and HTTP tests |

## Windows troubleshooting

- **Node or npm is unrecognized.** Reopen VS Code after installing Node.js and check `node --version`.
- **PowerShell blocks npm.** Run `npm.cmd ci`, `npm.cmd start`, or select **Command Prompt** as the VS Code terminal profile.
- **Dependencies cannot be downloaded.** Run `npm ci` in a terminal with access to `registry.npmjs.org`.
- **Port 3001 is in use.** Set a different port in PowerShell, for example `$env:PORT = '3002'`, then run `npm start`. Open the URL printed in the terminal. Run `Remove-Item Env:PORT` to return to port 3001.
- **The database cannot be opened.** Put the project or `STEADY_DATA_DIR` under a folder your Windows account can write to. Close any other Steady server using the same database.
- **The browser cannot connect.** Check that the terminal is still running and open the printed `127.0.0.1` address and port from the same computer.

