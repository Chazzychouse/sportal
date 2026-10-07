import { ScenarioScript } from "../ScenarioScript.ts"

/** An unranked team leading the No. 3 team late, beside a No. 1 team's blowout and an even first half. */
export const blowoutAndUpsetBrewing = ScenarioScript.build("blowout-and-upset-brewing", [
  {
    id: "upset-ala-van",
    home: "ALA",
    away: "VAN",
    network: "CBS",
    kickoff: "-2:50:00",
    ranking: { home: 3 },
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 4,
          clock: "8:30",
          score: [17, 24],
          ball: { team: "away", yardLine: 70, down: 1, distance: 10 }
        }
      ],
      [
        "1:30",
        {
          clock: "6:02",
          ball: { team: "away", yardLine: 45, down: 3, distance: 2 },
          play: { _tag: "Completion", touchdown: false, yards: 25 }
        }
      ],
      [
        "3:00",
        {
          clock: "4:15",
          ball: { team: "home", yardLine: 80, down: 1, distance: 10 },
          lastPlay: "Punt",
          play: { _tag: "Punt", return: "none", yards: 25 }
        }
      ],
      [
        "4:30",
        {
          clock: "2:20",
          ball: { team: "home", yardLine: 48, down: 4, distance: 3 },
          play: { _tag: "Completion", touchdown: false, yards: 32 }
        }
      ],
      [
        "5:30",
        {
          clock: "1:50",
          ball: { team: "away", yardLine: 52, down: 1, distance: 10 },
          lastPlay: "Turnover on downs",
          play: { _tag: "Incompletion", yards: 0 }
        }
      ]
    ]
  },
  {
    id: "upset-osu-akr",
    home: "OSU",
    away: "AKR",
    network: "BTN",
    kickoff: "-2:00:00",
    ranking: { home: 1 },
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 3,
          clock: "10:00",
          score: [49, 3],
          ball: { team: "home", yardLine: 35, down: 1, distance: 10 }
        }
      ],
      [
        "2:00",
        {
          clock: "7:45",
          score: [56, 3],
          ball: null,
          lastPlay: "Touchdown",
          play: { _tag: "Rush", touchdown: true, yards: 35 }
        }
      ]
    ]
  },
  {
    id: "upset-byu-utah",
    home: "BYU",
    away: "UTAH",
    network: "ESPN",
    kickoff: "-0:50:00",
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 2,
          clock: "12:20",
          score: [14, 14],
          ball: { team: "home", yardLine: 58, down: 2, distance: 8 }
        }
      ],
      [
        "3:00",
        {
          clock: "9:05",
          ball: { team: "home", yardLine: 37, down: 1, distance: 10 },
          play: { _tag: "Completion", touchdown: false, yards: 21 }
        }
      ]
    ]
  }
])
