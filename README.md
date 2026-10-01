# Facebook Private Cleaner

A Chrome / Edge extension that finds your **"Only me"** posts in the Facebook Activity Log and moves
them to **Facebook's Trash** in small, verified batches — after you approve the plan.

- Only posts whose audience is clearly **Only me** are touched. Friends, Public and anything uncertain are left alone.
- Posts go to **Trash**, not permanent deletion. You can restore them from Facebook's Trash.
- Everything runs in your browser. There is no server, and no post content leaves your computer.

> **Status:** proof of concept. Use it on your own account and at your own risk. Facebook changes its page
> layout often; if something looks wrong, the extension stops rather than guessing.

## 1. Install

You need [Node.js](https://nodejs.org/) (version 20.19 or newer) and Chrome or Edge.

```bash
git clone https://github.com/LKHVu/facebook-private-cleaner.git
cd facebook-private-cleaner
npm install
npm run build
```

This creates a `dist/` folder. Load it into the browser:

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `dist/` folder.
4. Pin **Facebook Private Cleaner** to the toolbar so it is easy to find.

**Updating:** pull the latest code, run `npm run build` again, click the reload icon on the extension's
card in `chrome://extensions`, and then reload your Facebook tab.

## 2. Open the Activity Log

1. Log in to Facebook in the same browser.
2. Click the extension icon. If you're not on the right page, click **Open Activity Log → Your posts**.
3. When the popup shows **✓ Facebook Activity Log detected**, click **Open persistent tester**.

The tester opens in its own window and stays open while you work. It always acts on the Facebook tab
you opened it from. **Keep that Facebook tab visible** (not minimized, not hidden behind another tab)
while the extension loads posts or cleans up.

## 3. Clean up private posts

The tester opens in **Simple** mode. Click **Clean up private posts** and follow the four steps.

### Step 1 — Find older posts

The Activity Log only shows recent posts at first. Choose how far back to look:

- **Current loaded posts only**
- **Load up to 250 posts**
- **Load up to 500 posts**
- **Load until Facebook stops returning posts** (500 at most)

Click **Start**. The extension scrolls the Facebook page for you; it doesn't select or change anything.
Click **Stop** at any time to keep what has loaded so far. When loading ends, the extension scans the posts automatically.

### Step 2 — Scan complete

This step shows how many posts were found, and how many are **Only me**, **Friends**, **Public** or
**Unknown**. Posts the extension isn't sure about are listed under **Review exceptions**. They are never
included in the cleanup.

### Step 3 — Cleanup plan

The extension groups the eligible **Only me** posts into batches of up to 20. A single run handles at
most **100 posts**; if there are more, the button reads **Run first 100**, and you can clean the
rest in another run afterwards.

- **Review posts** lists every post in the plan.
- **Limit this run** lets you try a smaller number first (a good idea the first time, for example 20).

Nothing has been selected on Facebook yet.

### Step 4 — Final approval

This step shows a summary: how many posts, how many batches, and the confirmation that they go to Trash
rather than being deleted. Click **Move N posts to Trash** to start, or **Cancel** to stop here.

### While it runs

For each batch, the extension selects the posts, opens Facebook's own Trash dialog, waits for a
**3-second countdown**, confirms, then checks that each post was actually removed before it moves on.

- **Stop run** stops safely. If a batch hasn't been confirmed yet, the extension cancels Facebook's dialog and unselects the posts.
- Facebook sometimes reloads the page after a batch. That is expected: the extension waits, rescans and continues.
- If the Facebook tab is hidden, the run pauses before the next batch. Bring the tab back and click **Resume**.
- If anything unexpected happens, the run **stops immediately** and explains why. Nothing is retried automatically.

### When it finishes

- **Cleanup finished** shows how many posts were moved, failed, uncertain or need review.
- **Clean remaining N** rescans the page and builds a new plan for posts that are still loaded. You approve it again.
- **Load older posts** returns to Step 1 so you can go further back in time.
- **Done** ends the cleanup.

If the run stopped, **Cleanup stopped** shows the reason. Use **Rescan and reconcile** to check the
current state of the page, or **End cleanup**.

## Restoring posts

Posts are moved to Facebook's Trash (Activity Log → **Trash**). Facebook keeps them there for about 30
days, and you can restore any of them from that page.

## Good to know

- **Try a small run first.** Use **Limit this run** with 20 posts to check that everything works with your account and language.
- **Don't click on the Facebook page during a run.** Selecting or unselecting posts yourself makes the extension stop to be safe.
- **Closing the tester is fine.** A run keeps going in the background; reopen the tester to see its progress.
- **Restarting the browser or reloading the extension** clears the current plan and run. Start a new cleanup afterwards.
- **"Could not initialize Facebook scanner"**: reload the Facebook tab, then click **Try again**.
- The extension **never** deletes permanently, archives, changes a post's audience, or starts a cleanup without your approval.

## Developer mode

The **Developer** switch at the top of the tester shows every lower-level tool: manual scans, single-post
actions, hand-picked batches, the cleanup queue and detailed debug panels. You don't need it for normal use.
The build layout, the safety checks and how audience detection works are described in
[docs/TECHNICAL.md](docs/TECHNICAL.md).
