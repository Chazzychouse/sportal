import { ScenarioScript } from "../ScenarioScript.ts"

/** Games kicking off two minutes apart, one of them in the NFL, the first scoring early. */
export const kickoffWindow = ScenarioScript.build("kickoff-window", [
  {
    id: "ko-ala-msst",
    home: "ALA",
    away: "MSST",
    network: "SECN",
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 1,
          clock: "15:00",
          ball: { team: "away", yardLine: 75, down: 1, distance: 10 }
        }
      ],
      [
        "1:00",
        {
          clock: "13:20",
          ball: { team: "away", yardLine: 52, down: 1, distance: 10 },
          play: { kind: "pass", yards: 23 }
        }
      ],
      [
        "3:00",
        { clock: "9:45", score: [0, 7], ball: null, lastPlay: "Touchdown", play: { kind: "pass", yards: 52 } }
      ]
    ]
  },
  {
    id: "ko-mia-unc",
    home: "MIA",
    away: "UNC",
    network: "ACCN",
    kickoff: "2:00",
    timeline: [
      [
        "2:00",
        {
          status: "live",
          period: 1,
          clock: "15:00",
          ball: { team: "home", yardLine: 75, down: 1, distance: 10 }
        }
      ],
      [
        "4:00",
        {
          clock: "12:10",
          ball: { team: "home", yardLine: 40, down: 2, distance: 3 },
          play: { kind: "pass", yards: 35 }
        }
      ]
    ]
  },
  {
    id: "ko-kc-buf",
    home: "KC",
    away: "BUF",
    league: "nfl",
    network: "CBS",
    kickoff: "4:00",
    timeline: [
      [
        "4:00",
        {
          status: "live",
          period: 1,
          clock: "15:00",
          ball: { team: "home", yardLine: 75, down: 1, distance: 10 }
        }
      ],
      [
        "6:00",
        {
          clock: "11:30",
          ball: { team: "home", yardLine: 22, down: 1, distance: 10 },
          play: { kind: "pass", yards: 53 }
        }
      ]
    ]
  },
  {
    id: "ko-usc-ucla",
    home: "USC",
    away: "UCLA",
    network: "FOX",
    kickoff: "6:00",
    timeline: [
      [
        "6:00",
        {
          status: "live",
          period: 1,
          clock: "15:00",
          ball: { team: "away", yardLine: 75, down: 1, distance: 10 }
        }
      ],
      [
        "7:00",
        {
          clock: "14:00",
          ball: { team: "away", yardLine: 61, down: 2, distance: 3 },
          play: { kind: "rush", yards: 14 }
        }
      ]
    ]
  }
])
