# ComebackApp

## Stack It Up! — Stacks Burgers

A one-tap burger-stacking arcade game. Open `index.html` in any browser (no build step, works offline).

## Comeback

A one-tap arcade game. Tap to throw a boomerang; it always comes back.

- **Play in a browser:** open `www/index.html`. No build step.
- **Controls:** tap or click to throw toward that spot. Hold to keep throwing. `P` / `Esc` pauses, `1`-`3` picks an upgrade.
- **Goal:** stop the swarm from reaching you. Hits on the return leg score double, kills build a combo,
  and experience orbs level you up with a choice of upgrades. A boss arrives every fifth wave.
- **Between runs:** gems buy permanent upgrades, and rotating quests pay out more gems. Progress is saved on the device.

### Public web version

`.github/workflows/pages.yml` publishes both games to GitHub Pages on every push to `main`:
Stack It Up! at the site root and Comeback under `/comeback/` (its privacy policy at
`/comeback/privacy.html`). One-time setup: repository
Settings > Pages > Source: **GitHub Actions**.

### iOS app

The game is wrapped with [Capacitor](https://capacitorjs.com). The Xcode project lives in `ios/`.

On a Mac with Xcode:

```sh
npm install
npm run ios        # copies www/ into the app and opens Xcode
```

In Xcode: select the **App** target > Signing & Capabilities > pick your team (change the bundle
identifier `com.gtrujillo.comeback` if you want a different one), run on a device, then
Product > Archive > Distribute App to upload to App Store Connect.

After changing anything in `www/`, run `npm run sync` before building.

- `resources/` - source app icon and launch image
- `store/` - App Store listing draft and screenshots
- `docs/privacy.html` - privacy policy page
