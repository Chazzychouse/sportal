import { Scenario } from "../Scenario.ts"

/** A tied top-five game decided by a two-minute drill, beside a blowout, a halftime, and a quiet first half. */
export const twoMinuteDrillTie = Scenario.build("two-minute-drill-tie", [
  {
    id: "tie-uga-ala",
    home: "UGA",
    away: "ALA",
    network: "CBS",
    kickoff: "-3:05:00",
    ranking: { home: 5, away: 2 },
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 4,
          clock: "2:10",
          score: [24, 24],
          timeouts: [2, 2],
          ball: { team: "home", yardLine: 75, down: 1, distance: 10 }
        }
      ],
      ["0:40", { clock: "1:48", ball: { team: "home", yardLine: 52, down: 2, distance: 4 } }],
      ["1:20", { clock: "1:12", ball: { team: "home", yardLine: 38, down: 1, distance: 10 } }],
      ["2:00", { clock: "0:41", ball: { team: "home", yardLine: 17, down: 1, distance: 10 } }],
      [
        "2:30",
        { clock: "0:22", timeouts: [1, 2], ball: { team: "home", yardLine: 9, down: 3, distance: 5 } }
      ],
      ["3:00", { clock: "0:03", score: [27, 24], ball: null, lastPlay: "Field goal is good" }],
      ["3:40", { status: "final", clock: "0:00" }]
    ]
  },
  {
    id: "tie-osu-mich",
    home: "OSU",
    away: "MICH",
    network: "FOX",
    kickoff: "-2:20:00",
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 3,
          clock: "6:30",
          score: [35, 7],
          ball: { team: "away", yardLine: 64, down: 2, distance: 7 }
        }
      ],
      ["1:30", { clock: "4:10", ball: { team: "away", yardLine: 49, down: 3, distance: 2 } }],
      [
        "3:00",
        { clock: "1:55", ball: { team: "home", yardLine: 80, down: 1, distance: 10 }, lastPlay: "Punt" }
      ]
    ]
  },
  {
    id: "tie-tex-ou",
    home: "TEX",
    away: "OU",
    network: "ABC",
    kickoff: "-1:40:00",
    timeline: [
      ["0:00", { status: "halftime", period: 2, clock: "0:00", score: [14, 10], ball: null }],
      [
        "4:00",
        {
          status: "live",
          period: 3,
          clock: "15:00",
          ball: { team: "away", yardLine: 75, down: 1, distance: 10 }
        }
      ]
    ]
  },
  {
    id: "tie-lsu-miss",
    home: "LSU",
    away: "MISS",
    network: "ESPN",
    kickoff: "-1:10:00",
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 2,
          clock: "9:12",
          score: [10, 3],
          ball: { team: "home", yardLine: 61, down: 1, distance: 10 }
        }
      ],
      ["2:00", { clock: "7:40", ball: { team: "home", yardLine: 44, down: 2, distance: 6 } }]
    ]
  }
])
