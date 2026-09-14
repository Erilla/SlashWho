# Blizzard achievement icon media research

Date: 2026-09-13

## Decision

Use Blizzard's official static Achievement Media API during Cutting Edge
catalogue generation. It supplies the in-game achievement icon without a
per-dossier request.

## Endpoint and authentication

1. Request a client-credentials access token from
   `POST https://oauth.battle.net/token` using the existing Blizzard client ID
   and secret.
2. Fetch `GET https://{region}.api.blizzard.com/data/wow/achievement/{id}`
   with `Authorization: Bearer {accessToken}`, `namespace=static-{region}`, and
   `locale=en_GB`.
3. Follow the returned `media.key.href`, or request
   `GET https://{region}.api.blizzard.com/data/wow/media/achievement/{id}`
   with the same authentication and static namespace.

Blizzard lists achievement and achievement-media resources in its [World of
Warcraft Game Data API reference](https://community.developer.battle.net/documentation/world-of-warcraft/game-data-apis).

## Verified response shape

An authenticated EU request for Cutting Edge achievement `40254` on 2026-09-13
returned an achievement `media.key.href`; its media response included:

```json
{
  "assets": [
    {
      "key": "icon",
      "value": "https://render.worldofwarcraft.com/eu/icons/56/5779391.jpg"
    }
  ],
  "id": 40254
}
```

Select the asset whose `key` is exactly `icon`. A missing or invalid value is
unavailable, not a reason to manufacture a URL. The returned public Blizzard
Render URL can be shown directly by the browser, keeping OAuth credentials on
the server.
