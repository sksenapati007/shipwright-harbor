# Create a Google OAuth client ID for Harbor

Harbor reads your Google Calendar, Gmail headers and Drive file names in your browser and sends a small snapshot to the
device. Google requires an OAuth *client ID* for that. Harbor ships none: you create your own (free, a few minutes), and the
sign-in token lives only in the page's memory.

You need: a Google account, and Harbor open from `https://sksenapati007.github.io/shipwright-harbor/`.

## Steps

1. Open <https://console.cloud.google.com/> and sign in. Create a project (top bar, project picker, **New project**), for example "Shipwright Harbor".
2. **Enable the APIs.** Menu, **APIs & Services**, **Library**. Search for and **Enable** each of:
   - Google Calendar API
   - Gmail API
   - Google Drive API
3. **Configure the consent screen.** **APIs & Services**, **OAuth consent screen** (in newer consoles: **Google Auth Platform**, **Branding / Audience**).
   - User type: **External**. App name: "Shipwright Harbor". Support and developer e-mail: yours.
   - **Audience / Test users:** add your own Google address. Leave the app in **Testing**; you do not need to publish or verify it for personal use.
     (Testing mode tokens expire after a short time, so Harbor will ask you to sign in again now and then.)
4. **Create the client.** **APIs & Services**, **Credentials**, **Create credentials**, **OAuth client ID**.
   - Application type: **Web application**. Name: "Harbor".
   - **Authorized JavaScript origins:** add `https://sksenapati007.github.io` (origin only: no path, no trailing slash).
     For local testing you may also add `http://localhost:4173`.
   - Leave *Authorized redirect URIs* empty (Harbor uses the token flow in a popup).
   - **Create**, then copy the **Client ID**. It ends in `.apps.googleusercontent.com`. You do not need the client secret; never paste it anywhere.
5. In Harbor, open **Calendar** (and **Gmail and Drive**), paste the client ID into the *Google client ID* box and sign in.
   Google shows a warning that the app is unverified: choose **Advanced**, **Continue** (it is your own app).
   Harbor remembers the ID in this browser (a client ID is public); it never stores the token.

## Scopes Harbor asks for (all read-only)

| Feature | Scope | What it can see |
| --- | --- | --- |
| Calendar | `https://www.googleapis.com/auth/calendar.readonly` | your events |
| Gmail | `https://www.googleapis.com/auth/gmail.metadata` | message headers and snippets, never bodies |
| Drive | `https://www.googleapis.com/auth/drive.metadata.readonly` | file names, types, dates and sizes, never contents |

## If it does not work

- *"redirect_uri_mismatch" or "origin_mismatch":* the authorized JavaScript origin does not exactly match the page you opened (check `https` and spelling).
- *"access_denied" or "app not verified":* add your address under **Test users** and try again.
- *"Google refused the request ... API is enabled":* one of the three APIs in step 2 is not enabled for this project.
- To revoke access: <https://myaccount.google.com/permissions>.
