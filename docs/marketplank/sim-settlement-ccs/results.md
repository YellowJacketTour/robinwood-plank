# CCS property-suite results

Settlements executed: 13373; solvency identity failures: 0 required — failures: 0

```json
{
  "checks": {
    "monotonicity": {
      "pairs": 3954,
      "equalStakeViolations": 0,
      "crossStakeTotalOrderingHolds": false,
      "crossStakeCounterexample": {
        "low": {
          "stake": "3602311047976446373",
          "m": "16104",
          "p": "1010208183184593087"
        },
        "high": {
          "stake": "2661099626294615543",
          "m": "21260",
          "p": "746261103760704548"
        }
      }
    },
    "sybil": {
      "cases": 4800,
      "maxGainWei": "7211305",
      "maxGainRelative": 4.90810608853713e-13,
      "worstCase": {
        "ms": [
          "25402",
          "25452"
        ],
        "gainWei": "7211305",
        "refPay": "14692642884883815557"
      },
      "note": "worst observed gain is lambda-grid requantization dust (sub-ppb), not an exploit"
    },
    "boundary": {
      "probes": 3200,
      "maxPayoutJumpPer1WeiStake": "34",
      "maxPayoutJumpPer1BpsTarget": "624617540328782"
    },
    "whale": {
      "table": [
        {
          "m": "10100",
          "mode": "interior",
          "netPct": -19.16
        },
        {
          "m": "15000",
          "mode": "interior",
          "netPct": -4.98
        },
        {
          "m": "27183",
          "mode": "interior",
          "netPct": -2.56
        },
        {
          "m": "50000",
          "mode": "interior",
          "netPct": -1.84
        },
        {
          "m": "100000",
          "mode": "interior",
          "netPct": -1.47
        },
        {
          "m": "200000",
          "mode": "interior",
          "netPct": -1.26
        },
        {
          "m": "399000",
          "mode": "interior",
          "netPct": -1.13
        }
      ],
      "bestNet": {
        "m": "399000",
        "netPct": -1.13
      },
      "coalitionNetPct": -1.15
    },
    "gCalibration": {
      "law": "P(crash >= m) = 1/m (exact _deriveCrash inverse-uniform); hazard h(m)=1/m, cumulative H(m)=ln m",
      "chosen": "g(m) = ln(m) == cumulative endured hazard; ex-ante premium weight ln(m)/m peaks at m=e",
      "rows": [
        {
          "mBps": "10100",
          "gScaled": "9950",
          "survivalProbBpsApprox": 9900,
          "exAntePremiumWeightPerUnit": 0.009851485148514852
        },
        {
          "mBps": "15000",
          "gScaled": "405465",
          "survivalProbBpsApprox": 6666,
          "exAntePremiumWeightPerUnit": 0.27031
        },
        {
          "mBps": "20000",
          "gScaled": "693147",
          "survivalProbBpsApprox": 5000,
          "exAntePremiumWeightPerUnit": 0.3465735
        },
        {
          "mBps": "27183",
          "gScaled": "1000006",
          "survivalProbBpsApprox": 3678,
          "exAntePremiumWeightPerUnit": 0.36787918919913176
        },
        {
          "mBps": "50000",
          "gScaled": "1609437",
          "survivalProbBpsApprox": 2000,
          "exAntePremiumWeightPerUnit": 0.3218874
        },
        {
          "mBps": "100000",
          "gScaled": "2302584",
          "survivalProbBpsApprox": 1000,
          "exAntePremiumWeightPerUnit": 0.2302584
        },
        {
          "mBps": "400000",
          "gScaled": "3688878",
          "survivalProbBpsApprox": 250,
          "exAntePremiumWeightPerUnit": 0.09222195
        },
        {
          "mBps": "1000000",
          "gScaled": "4605168",
          "survivalProbBpsApprox": 100,
          "exAntePremiumWeightPerUnit": 0.04605168
        }
      ]
    }
  },
  "scenarios": {
    "named": {
      "allBust": {
        "mode": "all-bust",
        "vault": "10000000000000000000"
      },
      "singleSurvivor": {
        "mode": "cap-excess",
        "payout": "1400000000000000000",
        "capExcess": "98600000000000000000",
        "split": {
          "burn": "19720000000000000000",
          "community": "39440000000000000000",
          "founders": "39440000000000000000"
        }
      },
      "floorScaled": {
        "mode": "floor-scaled",
        "payouts": [
          "500000000000000000",
          "500000000000000000"
        ]
      }
    },
    "round123Shaped": {
      "label": "round-123-SHAPED synthetic (NOT live data)",
      "mode": "interior",
      "lambda": "302341336287",
      "rows": [
        {
          "id": "DegenAlt",
          "lock": 39.83,
          "survived": true,
          "netPct": 86.4
        },
        {
          "id": "early1",
          "lock": 1.4,
          "survived": true,
          "netPct": -14.82
        },
        {
          "id": "early2",
          "lock": 1.5,
          "survived": true,
          "netPct": -12.74
        },
        {
          "id": "early3",
          "lock": 1.8,
          "survived": true,
          "netPct": -7.22
        },
        {
          "id": "early4",
          "lock": 2,
          "survived": true,
          "netPct": -4.04
        },
        {
          "id": "early5",
          "lock": 2.2,
          "survived": true,
          "netPct": -1.16
        },
        {
          "id": "mid1",
          "lock": 3,
          "survived": true,
          "netPct": 8.21
        },
        {
          "id": "mid2",
          "lock": 4.5,
          "survived": true,
          "netPct": 20.47
        },
        {
          "id": "buster",
          "lock": 42,
          "survived": false,
          "netPct": -100
        }
      ],
      "vaultRemainder": "5379805",
      "capExcess": "0"
    },
    "floorSweep": [
      {
        "fBps": "5000",
        "mode": "interior",
        "nets": {
          "DegenAlt": 153.13,
          "early1": -31.45,
          "early2": -27.64,
          "early3": -17.59,
          "early4": -11.78,
          "early5": -6.53,
          "mid1": 10.56,
          "mid2": 32.91,
          "buster": -100
        }
      },
      {
        "fBps": "6000",
        "mode": "interior",
        "nets": {
          "DegenAlt": 126.43,
          "early1": -24.8,
          "early2": -21.68,
          "early3": -13.44,
          "early4": -8.68,
          "early5": -4.38,
          "mid1": 9.62,
          "mid2": 27.94,
          "buster": -100
        }
      },
      {
        "fBps": "7000",
        "mode": "interior",
        "nets": {
          "DegenAlt": 99.74,
          "early1": -18.15,
          "early2": -15.72,
          "early3": -9.3,
          "early4": -5.59,
          "early5": -2.23,
          "mid1": 8.68,
          "mid2": 22.96,
          "buster": -100
        }
      },
      {
        "fBps": "7500",
        "mode": "interior",
        "nets": {
          "DegenAlt": 86.4,
          "early1": -14.82,
          "early2": -12.74,
          "early3": -7.22,
          "early4": -4.04,
          "early5": -1.16,
          "mid1": 8.21,
          "mid2": 20.47,
          "buster": -100
        }
      },
      {
        "fBps": "8000",
        "mode": "interior",
        "nets": {
          "DegenAlt": 73.05,
          "early1": -11.5,
          "early2": -9.75,
          "early3": -5.15,
          "early4": -2.49,
          "early5": -0.08,
          "mid1": 7.74,
          "mid2": 17.98,
          "buster": -100
        }
      },
      {
        "fBps": "9000",
        "mode": "interior",
        "nets": {
          "DegenAlt": 46.36,
          "early1": -4.85,
          "early2": -3.79,
          "early3": -1,
          "early4": 0.6,
          "early5": 2.06,
          "mid1": 6.8,
          "mid2": 13,
          "buster": -100
        }
      },
      {
        "fBps": "9500",
        "mode": "interior",
        "nets": {
          "DegenAlt": 33.01,
          "early1": -1.52,
          "early2": -0.81,
          "early3": 1.06,
          "early4": 2.15,
          "early5": 3.13,
          "mid1": 6.33,
          "mid2": 10.51,
          "buster": -100
        }
      }
    ]
  },
  "settlements": 13373,
  "failures": []
}
```
