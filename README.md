# Mobile Timer for Clockify

Mobile Timer for Clockify starts, stops and switches your Clockify timer from a note. It shows the running timer and today's total.

It is an unofficial plugin, not affiliated with Clockify or CAKE.com. You need your own Clockify account and API key. Pro is optional.

## Features

<img src="https://raw.githubusercontent.com/theluckystrike/clockify-mobile-timer/HEAD/docs/mobile-timer.gif" alt="The timer panel with no timer, the Start timer window, a running timer, and the timer stopped" width="720">

### Start, stop and switch a timer

<img src="https://raw.githubusercontent.com/theluckystrike/clockify-mobile-timer/HEAD/docs/start-modal.png" alt="The Start timer window with the note name as the description and the default project below it" width="720">

Run "Start timer", enter a description (the window offers the note name) and select Start. "Stop timer" stops it. "Switch timer" stops the running one and starts a new one.

"Start timer for this note" starts at once with no window. Both send the note name to Clockify as the description. A setting turns that off. Free timers get one default project.

### Start a timer from a task line

<img src="https://raw.githubusercontent.com/theluckystrike/clockify-mobile-timer/HEAD/docs/task-timer.png" alt="A note with a task list and the status bar with a running timer whose description is the text of one task, without the checkbox and the date" width="720">

Put the cursor on a line and run "Start timer for this task", or select it in the editor menu. The line becomes the description, without list and checkbox marks, link brackets, block ids and Tasks plugin dates, cut at 120 characters. A running timer stops first. A line with no text has no command.

### The timer panel and the ribbon button

<img src="https://raw.githubusercontent.com/theluckystrike/clockify-mobile-timer/HEAD/docs/timer-panel.png" alt="The timer panel with a running timer of 27 minutes, today's total and three finished entries" width="720">

A phone has no status bar, so the plugin has a timer panel. Run "Open timer panel". It shows the clock, today's total, the buttons and today's finished entries. The ribbon button turns red while a timer runs.

### The status bar on desktop

<img src="https://raw.githubusercontent.com/theluckystrike/clockify-mobile-timer/HEAD/docs/status-bar.png" alt="The status bar with a running timer, its description and today's total" width="720">

On desktop the status bar shows the clock, the project, the description and today's total. Select it for the panel.

### A request budget

<img src="https://raw.githubusercontent.com/theluckystrike/clockify-mobile-timer/HEAD/docs/rate-limit.png" alt="The timer panel after Clockify answered HTTP 429, with the wait time in the status pill" width="720">

The plugin keeps a limit of its own: 120 requests in a rolling hour. Start and Stop cost one request each. Background refreshes stop when 8 requests are left. After HTTP 429 the plugin follows the Retry-After header, or waits 1 minute, then 2, then 4, up to 20.

### Project and tag pickers (Pro)

<img src="https://raw.githubusercontent.com/theluckystrike/clockify-mobile-timer/HEAD/docs/project-picker.png" alt="The Start timer window with a project list set to Code and a tags field" width="720">

The Start window gets a project list and a tags field for names of existing Clockify tags, separated by commas. A note can set its own project with a property named `clockify-project`.

### Reports by project, day or description (Pro)

<img src="https://raw.githubusercontent.com/theluckystrike/clockify-mobile-timer/HEAD/docs/report.png" alt="Two report tables in a weekly report note: hours by project and hours by day" width="720">

Add a `clockify-report` code block to a note. `range` is today, yesterday, last7, week, month, or two dates like `2026-10-01..2026-10-31`. `by` is project, day or description.

~~~
```clockify-report
range: week
by: project
```
~~~

A report reads up to 2,000 entries and the plugin keeps the answer for 15 minutes.

### Edit and delete past entries (Pro)

<img src="https://raw.githubusercontent.com/theluckystrike/clockify-mobile-timer/HEAD/docs/edit-entry.png" alt="The Edit time entry window with description, project, start and stop" width="720">

Each finished entry in the panel has an edit button. The window changes the description, project, start and stop time. Select Delete twice to delete it.

### Offline queue (Pro)

<img src="https://raw.githubusercontent.com/theluckystrike/clockify-mobile-timer/HEAD/docs/offline-queue.png" alt="The timer panel with a timer started offline and a line that says one change waits to be sent" width="720">

With no connection, a start or stop waits in a queue of up to 40 changes and shows in the panel at once. When Clockify is reachable, the queue goes out in the fewest requests. Without Pro, nothing changes offline.

## Install

Open Settings, then Community plugins, then Browse, and search for "Mobile Timer for Clockify". Select Install.

To install by hand, put `main.js`, `manifest.json` and `styles.css` from the latest release in `<vault>/.obsidian/plugins/clockify-mobile-timer/`. It needs Obsidian 1.13.4 or newer.

## Usage

1. In Clockify, open your profile settings, then API, and select Generate. If your workspace is on a subdomain, generate the key there.
2. In the plugin settings, select the API key field, create a secret and paste the key. Select Check connection.
3. Open a note and run "Start timer".

A timer that you start in Clockify shows after the next refresh.

## Pro

<img src="https://raw.githubusercontent.com/theluckystrike/clockify-mobile-timer/HEAD/docs/pro-settings.png" alt="The Pro section of the settings before sign in, with the sponsor button and the GitHub sign in" width="720">

Pro unlocks the features marked (Pro). $5 a month, or $15 once. A total payment of $15 meets the payment requirement for Pro without further payment. Sign-in and the checks below still apply.

1. Sponsor [theluckystrike on GitHub Sponsors](https://github.com/sponsors/theluckystrike).
2. In the plugin settings, select "Sign in with GitHub".
3. The plugin copies a code and opens github.com/login/device. Paste the code there and approve.

See [Payment, account and network](#payment-account-and-network) for the check and offline limits.

## Settings

<img src="https://raw.githubusercontent.com/theluckystrike/clockify-mobile-timer/HEAD/docs/settings.png" alt="Settings with the API key in secret storage, the default project, the status bar switch and the note title switch" width="720">

| Setting | Default | Allowed values |
| --- | --- | --- |
| Show timer in the status bar | On | On or off (desktop only) |
| Use the note title as the description | On | On or off |
| Ask Clockify again after | 10 minutes | 5 to 60, in steps of 5 |
| Week starts on | Monday | Monday or Sunday |


## FAQ

### Can I use it on a phone?

The manifest does not set it to desktop only. The automatic tests run on desktop only. On a phone, use the timer panel.

### Which entries does the day total count?

The entries that start yesterday or today, up to 300, cut at local midnight. A timer that started before yesterday shows after "Refresh timer". The plugin uses your default Clockify workspace.

### Does the key sync to my other devices?

No. Obsidian keeps secrets on the device. Paste the key on each device.

## Payment, account and network

The core features are free. Pro features need a GitHub Sponsors sponsorship of theluckystrike: $5 a month or more, or $15 once. A total payment of $15 meets the payment requirement for Pro without further payment. Sign-in and the checks below still apply. Your notes stay readable and editable with or without Pro.

GitHub handles the payment. Sponsor at https://github.com/sponsors/theluckystrike. You need a Clockify account for every feature, free or Pro. Pro also needs the GitHub account that sponsors.

Mobile Timer for Clockify talks to Clockify through its public API at `https://api.clockify.me/api/v1`, only after you save a Clockify API key in the settings. It stays in the secret storage of Obsidian on this device, not in data.json or in a note. Each request carries it in the X-Api-Key header. When you start, stop, edit or delete a timer, the plugin sends the time entry data the call needs: the description, the project id, the tag ids, the start and end time, and, on an edit, the task id and the billable flag. The workspace id, the user id and the entry id are in the address of the request. When you start a timer from a note, the title of the note becomes the description and is sent to Clockify. That happens when you run "Start timer for this note", and when you select Start in the Start window, which opens with the title in its box. The title is the file name without the folder and the extension, cut at 120 characters. Turn off "Use the note title as the description" to send no title. When you run "Start timer for this task", the text of the line at the cursor becomes the description and is sent to Clockify, without list marks, link brackets and Tasks plugin dates. The note title setting does not change this. The plugin sends no other note content, no folder path and no other vault data, and it has no telemetry. It reads your name, user id, default workspace, projects, tags, running timer and time entries from Clockify when Obsidian opens, when you return to the app or go online, when you open the panel, when you select Refresh, Check connection or Load projects, and when a report block draws. With Pro it also reads when you open the Start window or start a timer from a note whose project is not in the saved list. Each request shows Clockify your IP address. The plugin keeps a copy of your recent entries, projects, tags and queued changes in data.json in your vault. Mobile Timer for Clockify is an unofficial plugin. It is not affiliated with, made by or approved by Clockify or CAKE.com. Clockify is a mark of its owner.

Until you select "Sign in with GitHub" in the settings, Mobile Timer for Clockify sends nothing to GitHub. Sign in uses the GitHub device flow. Mobile Timer for Clockify sends its public client ID and the scope `read:user` to `https://github.com/login/device/code` and shows you a code. While you enter the code at https://github.com/login/device, it asks `https://github.com/login/oauth/access_token` every few seconds to check the sign-in status. The scope permits profile reads only. GitHub needs this access to show the sponsorship tier. It grants no repository scope and no write access.

After sign in, Mobile Timer for Clockify sends one query to `https://api.github.com/graphql`. It checks if the signed-in account sponsors theluckystrike. It asks for the tier and the total payment to theluckystrike. The plugin reuses a successful check for 7 days. Failed checks can retry after 6 hours. Select Refresh to request an earlier check. It sends no note content, file names or other vault data to GitHub, and it has no telemetry.

After a successful check, Pro can work offline for up to 14 days. Sign out or a negative sponsorship answer turns Pro off. The plugin stores the GitHub token through the secret storage API of Obsidian. It does not put the token in its saved settings or its local sponsorship data. The local storage of this device keeps your GitHub login, the tier and the time of the last check. Sign out clears the token. You can also revoke the access in your GitHub settings, under Applications.

## Support

Report a bug or ask for a feature in the issue tracker of this repository. To support the work, use [GitHub Sponsors](https://github.com/sponsors/theluckystrike).

```
npm ci
npm run build
npm test
```

## License

MIT
