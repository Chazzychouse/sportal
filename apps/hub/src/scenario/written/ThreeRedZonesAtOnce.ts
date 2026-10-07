import { ScenarioScript } from "../ScenarioScript.ts"

/**
 * Three red-zone trips at once, of different worth: a one-score fourth quarter, a tie in the third, and a
 * blowout. They end in a go-ahead touchdown, an interception, and a garbage-time field goal.
 */
export const threeRedZonesAtOnce = ScenarioScript.build("three-red-zones-at-once", [
  {
    id: "rz-psu-iowa",
    home: "PSU",
    away: "IOWA",
    network: "CBS",
    kickoff: "-3:00:00",
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 4,
          clock: "5:20",
          score: [17, 13],
          ball: { team: "away", yardLine: 34, down: 2, distance: 6 }
        }
      ],
      ["1:00", { clock: "4:31", ball: { team: "away", yardLine: 12, down: 1, distance: 10 } }],
      ["2:00", { clock: "3:58", score: [17, 20], ball: null, lastPlay: "Touchdown" }]
    ]
  },
  {
    id: "rz-fsu-clem",
    home: "FSU",
    away: "CLEM",
    network: "ABC",
    kickoff: "-2:00:00",
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 3,
          clock: "8:05",
          score: [21, 21],
          ball: { team: "home", yardLine: 30, down: 1, distance: 10 }
        }
      ],
      ["1:00", { clock: "7:20", ball: { team: "home", yardLine: 15, down: 2, distance: 5 } }],
      [
        "2:30",
        {
          clock: "6:02",
          ball: { team: "away", yardLine: 92, down: 1, distance: 10 },
          lastPlay: "Interception"
        }
      ]
    ]
  },
  {
    id: "rz-ore-wash",
    home: "ORE",
    away: "WASH",
    network: "FOX",
    kickoff: "-3:10:00",
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 4,
          clock: "9:40",
          score: [38, 10],
          ball: { team: "home", yardLine: 41, down: 1, distance: 10 }
        }
      ],
      ["1:00", { clock: "8:55", ball: { team: "home", yardLine: 8, down: 1, distance: 8 } }],
      ["3:00", { clock: "7:10", score: [41, 10], ball: null, lastPlay: "Field goal is good" }]
    ]
  },
  {
    id: "rz-ksu-isu",
    home: "KSU",
    away: "ISU",
    network: "ESPN",
    kickoff: "-1:00:00",
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 2,
          clock: "11:00",
          score: [7, 7],
          ball: { team: "away", yardLine: 55, down: 1, distance: 10 }
        }
      ],
      ["2:00", { clock: "9:30", ball: { team: "away", yardLine: 50, down: 3, distance: 5 } }]
    ]
  }
])
