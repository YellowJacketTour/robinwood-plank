# Burning Heart social custody gate

Migration 148 expands receipt and stamp identity constraints only. It issues no items and changes no historical quantities. Oran remains the only item exposed by existing HTTP routes and clients.

The internal `charmSocial` policy requires both `burningHeart: true` and `clientProtocol: "social-items-v2"`. Request-body fields cannot activate it. Do not derive this argument directly from client JSON. Future activation must establish a trusted deployment policy and negotiated supported client, accepted artwork, deployed schema, and the separately accepted native issuance flow. The registry intentionally has no invented Heart image URL.

Heart pins debit one existing `burning-heart` stack into one post stamp and one receipt in the same transaction. They never consume Oran, create a second social balance, or issue currency. Replays retain original domain/payload order; reusing a request ID for another face fails. Legacy reads omit Heart and retain `oranPins` and the Oran-only basket shape.

Validation: isolated local PostgreSQL covers rejected default/client-forged activation, accepted internal policy, independent face custody, duplicate receipt replay, changed-face request rejection, concurrent last-item spends, per-item totals, and legacy response compatibility. No production activation or frontend changes belong to this increment.
