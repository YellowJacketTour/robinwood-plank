# Account peer projection

The parent projects its server-filtered peers with `{type:'charmville:account-peers',active:true,peers:[{profileId,handle,x,y}]}`. Coordinates are native pixels (server grid times8). The bridge requires the actual parent and allowed local origin, at most16 unique identities, bounded8px-grid coordinates and bounded identifier strings. Names are not interpreted as script or rendered as HTML.

Embedded native sessions initialize empty account mode. `account-peers.txt` in the quest-scoped Files directory stores `1|count|x|y...`. Receiving no refresh for6500ms clears the projection. Signout/expiry sends active:true with an empty list; active:false also clears without restoring guest mode. Standalone unembedded native play retains its separate guest relay. Account mode neither sends legacy guest position messages nor renders guest relay actors, so those two populations are not mixed.

Native rendering uses a fixed downward-facing native hero reference tile at the accepted coordinates on DMap4/screen63. It sorts before/after the local hero by y. It does not yet reproduce peer direction, walking cycles, cosmetics, equipment, followers or collision entities. No account ownership is established by the bridge itself: the parent must use the authenticated server response and enforce private/public instance filtering.

`account-peers.test.mjs` verifies bounded input, duplicate rejection, real-parent checks, empty initialization and stale clearing. `verify-native-party-projection.mjs --peers` is explicitly a synthetic two-peer rendering/clear fixture, not proof that those fixtures belong to authenticated players. Root's separate account integration test verifies actual persisted peer selection.
