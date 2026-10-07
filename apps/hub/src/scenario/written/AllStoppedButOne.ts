import { ScenarioScript } from "../ScenarioScript.ts"

/**
 * Every game stopped but one: a halftime, a timeout, the end of a quarter, and a weather delay, while one game
 * goes for it on fourth down late and scores.
 */
export const allStoppedButOne = ScenarioScript.build("all-stopped-but-one", [
  {
    id: "still-aub-ark",
    home: "AUB",
    away: "ARK",
    network: "SECN",
    kickoff: "-3:15:00",
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 4,
          clock: "1:55",
          score: [20, 23],
          ball: { team: "home", yardLine: 33, down: 4, distance: 2 }
        }
      ],
      [
        "0:30",
        {
          clock: "1:40",
          ball: { team: "home", yardLine: 29, down: 1, distance: 10 },
          play: { _tag: "Rush", touchdown: false, yards: 4 }
        }
      ],
      [
        "1:00",
        {
          clock: "1:02",
          ball: { team: "home", yardLine: 21, down: 2, distance: 2 },
          play: { _tag: "Rush", touchdown: false, yards: 8 }
        }
      ],
      [
        "1:30",
        {
          clock: "0:40",
          ball: { team: "home", yardLine: 14, down: 1, distance: 10 },
          play: { _tag: "Completion", touchdown: false, yards: 7 }
        }
      ],
      [
        "2:30",
        {
          clock: "0:31",
          score: [27, 23],
          ball: null,
          lastPlay: "Touchdown",
          play: { _tag: "Rush", touchdown: true, yards: 14 }
        }
      ]
    ]
  },
  {
    id: "still-tenn-uk",
    home: "TENN",
    away: "UK",
    network: "ESPN",
    kickoff: "-1:35:00",
    timeline: [
      ["0:00", { status: "halftime", period: 2, clock: "0:00", score: [17, 14], ball: null }],
      [
        "5:00",
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
    id: "still-wisc-minn",
    home: "WISC",
    away: "MINN",
    network: "BTN",
    kickoff: "-2:10:00",
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 3,
          clock: "4:12",
          score: [13, 10],
          timeouts: [3, 2],
          ball: { team: "home", yardLine: 66, down: 3, distance: 4 },
          lastPlay: "Timeout Minnesota"
        }
      ],
      [
        "3:30",
        {
          clock: "3:40",
          ball: { team: "home", yardLine: 58, down: 1, distance: 10 },
          lastPlay: "Pass complete",
          play: { _tag: "Completion", touchdown: false, yards: 8 }
        }
      ]
    ]
  },
  {
    id: "still-unc-duke",
    home: "UNC",
    away: "DUKE",
    network: "ACCN",
    kickoff: "-0:35:00",
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 1,
          clock: "0:00",
          score: [3, 0],
          ball: null,
          lastPlay: "End of 1st Quarter"
        }
      ],
      ["3:00", { period: 2, clock: "15:00", ball: { team: "away", yardLine: 70, down: 1, distance: 10 } }]
    ]
  },
  {
    id: "still-hou-rice",
    home: "HOU",
    away: "RICE",
    network: "ESPNU",
    kickoff: "-1:00:00",
    timeline: [
      [
        "0:00",
        { status: "delayed", period: 2, clock: "6:12", score: [7, 10], ball: null, lastPlay: "Weather delay" }
      ]
    ]
  }
])
