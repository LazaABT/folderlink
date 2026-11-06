# Folderlink

Keep a folder the same on two computers from a web page. Files go directly from one browser to the other over WebRTC. They aren't uploaded to a server.

## Use it

1. On one computer, open the page in Chrome or Edge and choose a folder to share.
2. Send the share link or code to the other computer. Keep the sharing tab open.
3. On the other computer, open the link or enter the code, then choose a folder to sync with.
4. Check the summary and select **Start syncing**.

After that, changes on either computer are copied across every 15 seconds while both tabs are open. **Sync now** runs a check straight away.

To copy a file somewhere else, drag it out of the list. You can also use the synced folder as normal in File Explorer.

## How syncing behaves

| What happened | Result |
| --- | --- |
| File added or edited on one computer | Copied to the other |
| File deleted on one computer | Deleted on the other, with a copy kept in `.folderlink-trash` |
| File edited on both computers | Both kept. One is renamed with `(conflict <date>)` |
| File deleted on one computer, edited on the other | The edit wins and the file comes back |
| Same name but different content on first sync | Both kept. Nothing is deleted on a first sync |
| File locked by another program | Skipped until it's free |
| Many files disappear at once | Syncing pauses those deletions and asks whether to delete or restore them |

### Getting deleted files back

Browsers can't use the Recycle Bin. Deleted files move to `.folderlink-trash` inside the synced folder, sorted by date. That folder doesn't sync and isn't emptied automatically, so delete it by hand when you want the space back.

## Publish on GitHub Pages

1. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with access to all repositories and Read and write on **Administration**, **Contents** and **Pages**.
2. Put it in `.env` as `GITHUB_TOKEN`. `GITHUB_REPO` sets the repository name.
3. Run the script below. It creates a private repository, pushes this folder and turns on Pages.

```bash
py publish.py
```

GitHub only offers Pages on private repositories with a paid plan such as GitHub Pro. On a free account the push works, then the script stops and says so. Even with a paid plan, the code stays private but the web page itself is public.

The script stops before pushing if `.env` would be committed or if any file contains your token.

## Settings and API keys

The default setup needs no API keys. It uses the free PeerJS connection service to introduce the two browsers.

To use your own connection service or a relay, fill in `.env`, then run:

```bash
python build_config.py
```

Publish the new `config.js` afterwards. GitHub Pages sites are public, so everything in `config.js` can be read by anyone. Only use credentials that are made for browsers, such as short-lived or restricted TURN credentials.

## Run it locally

Folder access and WebRTC need `https://` or `localhost`, so opening `index.html` directly won't work.

```bash
python -m http.server 8123 --bind 127.0.0.1
```

Then open `http://localhost:8123`.

## Security

- The connection service sees a hash of the share code, not the code itself.
- Both computers prove they hold the code before any file information is sent.
- Transfers are encrypted by WebRTC.
- Anyone with the code can read, change and delete files in the shared folder, so treat it like a password. **Stop sharing** retires it.
- Only share a folder with computers you trust. They can add any kind of file to it, including programs.
- A dishonest connection service could try to intercept a connection, because it passes along the details used to set up encryption. Run your own if that matters to you.

## Limits

- Both computers need desktop Chrome or Edge, with the tab open. Syncing stops when either tab closes and catches up when it's back.
- Dragging out of the list works on one file at a time, and only for files that have finished downloading.
- Windows treats `Photo.jpg` and `photo.jpg` as the same file but Linux doesn't, so avoid names that differ only by capitals when syncing between them.
- Guest networks and some routers stop devices reaching each other. A TURN relay gets around this, but files then pass through the relay, still encrypted.
