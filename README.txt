PR PORTAL INSPECTOR & RECORDER — PORTABLE WINDOWS EDITION

GOAL
- Runs from its own extracted folder with a bundled-in-folder Node.js runtime, local npm dependencies, and local Playwright Chromium.
- Does not require a global Node.js installation.
- Start from Start-Here.hta; no manual PowerShell commands are needed.

FIRST-TIME SETUP (INTERNET REQUIRED)
1. Extract the entire ZIP into a normal writable folder, e.g. C:\PR_Status_Automation\PR_Inspector_Portable.
2. Double-click Start-Here.hta and press Start Inspector.
3. On first launch, the helper downloads the official Node.js Windows x64 ZIP into a temporary folder, extracts the portable runtime into runtime\node, installs app dependencies into node_modules, and installs Playwright Chromium into browsers\.
4. The first setup may take several minutes. Keep the folder on a local drive with enough free space. Office proxy/firewall rules may block downloads.
5. After setup succeeds, the app is self-contained in this folder and can run without a globally installed Node.js or an internet connection for these runtime components. The Ariba portal itself still requires your authorized network/VPN.
6. On later launches, double-click Start-Here.hta again. Start-App.bat is the fallback launcher. Run-Server.bat is an advanced fallback and opens a visible server console.

PORTABLE FOLDER CONTENTS
- runtime\node\: private Node.js runtime and npm; do not delete.
- node_modules\: app dependencies; do not delete.
- browsers\: Playwright Chromium browser; do not delete.
- output\: JSON recordings, screen frames, inspections and draft scripts.
- input\: imported workbook files.
- Start-Here.hta: one-click graphical launcher.
- Start-App.bat: setup and launch helper.
- First-Run-Setup.ps1: downloads/extracts the official portable Node.js runtime only when missing.

MOVING TO ANOTHER PC OR FOLDER
- Close the app/server first, then copy the entire folder, including runtime, node_modules, browsers, output, and input.
- Keep the folder structure intact. Because the Playwright browser path is configured relative to this folder, it can be moved as a unit.
- A new PC may require the one-time setup again if runtime/dependencies/browser files were not copied. The first-time setup requires internet access.

FEATURES
- Compact pastel PWA-style GUI with sidebar, hamburger collapse, pinning, live activity and status cards.
- Default JSW Ariba portal URL, editable in Portal & Login.
- Sidebar Start/Stop recording controls and timestamped recordings.
- Component inspection, numbered sequence, component-type colours, yellow click/selection markers and hover capture.
- Screen snapshots with visible markers; this is a sequence of frames, not a continuous video.
- Sequence playback is visual only; it does not replay clicks or submit forms.
- Past recordings list, timestamps, age, component counts and screen-frame counts.
- Excel input queue: upload a workbook, pick the PR-number column, click Run lookup. Each number is searched in the logged-in Playwright browser (read-only), and the current stage plus days at that stage are written to output\PR_status_results_<time>.xlsx (green rows = success, red = NOT_FOUND/ERROR). A Debug sheet and output\lookup_debug\ hold page text and screenshots per row for tuning.
- lookup-config.json holds the search selectors, stage/date labels, date order (DMY or MDY) and optional tabs to open. Edit it and run again; no restart needed.
- HELP.html and public\help.html provide detailed instructions and safety notes.

Troubleshooting: If Chromium setup previously failed with 'node is not recognized', use this updated Start-App.bat. It adds the bundled runtime\node folder to PATH for this app only, then rerun Start-App.bat. It does not change the system PATH or require global Node.js.

TROUBLESHOOTING
- If Start-Here.hta is blocked by Windows or office policy, double-click Start-App.bat.
- If downloads fail, verify internet/proxy access to https://nodejs.org and the npm registry. Ask IT to allow approved downloads if needed; do not bypass company policy.
- If Chromium download fails, check network/proxy restrictions and run Start-App.bat again. It resumes setup by checking whether the required folders exist.
- Keep this folder writable; Node, dependencies, browser files, recordings, and screenshots are stored inside it.
- Do not delete runtime, node_modules, or browsers. If one is corrupted, close the app and rerun Start-App.bat while online.
- If the GUI does not open, check whether http://127.0.0.1:3030 is already in use. Close duplicate server instances before retrying.

SAFETY AND PRIVACY
- Use only on systems and records you are authorized to access.
- Do not automate approval, release, rejection, delete, save, or other write actions.
- The read-only guard cannot guarantee every portal action is harmless.
- Never share credentials, OTPs, cookies, session tokens, or secrets.
- Recordings can contain internal URLs, PR numbers, names, text, and screenshots. Review captures before sharing them.
- The local server binds to 127.0.0.1. Do not expose it to the network.
