import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import type { TeamId } from "@sportal/domain/Team"
import { Array as Arr, DateTime, Schema } from "effect"
import { FeedFrame } from "../../Frame.ts"
import { Scenario } from "../../scenario/Scenario.ts"
import type { ScenarioScript } from "../../scenario/ScenarioScript.ts"
import * as EspnEvent from "./EspnEvent.ts"
import * as EspnPlay from "./EspnPlay.ts"
import * as FastCastMessage from "./FastCastMessage.ts"

/**
 * `script` as a scenario of the frames ESPN would have sent, under the script's name, starting at its origin. Instants
 * stay as written, kickoffs among them: playing the scenario moves when each frame is received, not what it says.
 */
export function scenarioOf(script: ScenarioScript): Scenario {
  return new Scenario({ name: script.name, frames: framesOf(script) })
}

/**
 * `script` as the frames ESPN would have sent, in the order received: at each step, a scoreboard poll per league on the
 * slate; 1 ms later, an empty checkpoint of each game's play-by-play topic the first time a poll lists the game; and
 * 2 ms after the polls, one message per play on its game's topic, numbered from 1 per topic.
 */
function framesOf(script: ScenarioScript): ReadonlyArray<FeedFrame> {
  const [, frames] = Arr.mapAccum(
    script.steps,
    { listed: new Set<GameId>(), mids: new Map<string, number>() },
    ({ listed, mids }, step) => {
      const polledAt = DateTime.add(script.origin, { milliseconds: step.at })
      const polls = LeagueId.literals.flatMap((league) => {
        const games = step.slate.filter((game) => game.league === league)
        return games.length === 0
          ? []
          : [
              new FeedFrame({
                receivedAt: polledAt,
                feed: "poll",
                channel: league,
                kind: "response",
                body: encodeScoreboard({ events: games.map(eventOf) })
              })
            ]
      })
      const checkpoints = step.slate
        .filter((game) => !listed.has(game.id))
        .map(
          (game) =>
            new FeedFrame({
              receivedAt: DateTime.add(polledAt, { milliseconds: 1 }),
              sourceId: 0,
              feed: "fastcast",
              channel: FastCastMessage.topic(game.league, game.id),
              kind: "checkpoint",
              body: JSON.stringify({ entities: { plays: {} } })
            })
        )
      const [numbered, messages] = Arr.mapAccum(
        step.plays.map(({ game, league, play }) => ({ topic: FastCastMessage.topic(league, game), play })),
        mids,
        (soFar, { topic, play }) => {
          const mid = (soFar.get(topic) ?? 0) + 1
          return [
            new Map([...soFar, [topic, mid]]),
            message(topic, mid, DateTime.add(polledAt, { milliseconds: 2 }), entityOf(play))
          ] as const
        }
      )
      return [
        { listed: new Set([...listed, ...step.slate.map((game) => game.id)]), mids: numbered },
        [...polls, ...checkpoints, ...messages]
      ] as const
    }
  )
  return frames.flat()
}

const encodeScoreboard = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ events: Schema.Array(EspnEvent.Raw) }))
)

/** The game as the site scoreboard lists it, its yard line counted from the home goal line as ESPN counts it. */
function eventOf(game: GameSnapshot): typeof EspnEvent.Raw.Type {
  const side = (homeAway: "home" | "away") => {
    const { team, score, ranking } = game[homeAway]
    return {
      homeAway,
      score,
      curatedRank: { current: ranking },
      team: {
        id: espnId(team.id),
        abbreviation: team.abbreviation,
        displayName: team.name,
        location: team.location,
        shortDisplayName: team.shortName,
        logo: team.logo,
        color: team.color,
        alternateColor: team.alternateColor
      }
    }
  }
  const situation = game.situation
  return {
    id: game.id,
    date: game.kickoff,
    status: { period: game.period, displayClock: game.clock, type: game.status },
    competitions: [
      {
        geoBroadcasts: game.broadcasts.map(({ network, medium }) => ({
          type: { shortName: medium === "tv" ? "TV" : "Streaming" },
          media: { shortName: network }
        })),
        situation:
          situation === undefined
            ? undefined
            : {
                possession: situation.possession === undefined ? undefined : espnId(situation.possession),
                down: situation.down,
                distance: situation.distance,
                yardLine:
                  situation.yardLine === undefined || situation.possession !== game.home.team.id
                    ? situation.yardLine
                    : 100 - situation.yardLine,
                homeTimeouts: situation.homeTimeouts,
                awayTimeouts: situation.awayTimeouts,
                lastPlay: situation.lastPlay === undefined ? undefined : { text: situation.lastPlay }
              },
        competitors: [side("home"), side("away")]
      }
    ]
  }
}

const encodeEntity = Schema.encodeSync(EspnPlay.Entity)

/**
 * The play as a game package lists it, its teams by ESPN's own ids. A play that gains no yards (a timeout, a stoppage,
 * a period's end) is written as ESPN writes one: no yards, and the team with the ball.
 */
function entityOf(play: Play): typeof EspnPlay.Entity.Encoded {
  const ref = (team: TeamId | undefined) => (team === undefined ? undefined : espnId(team))
  const spot = ({ team, down, distance, yardsToEndzone }: Play["end"]) => ({
    team: ref(team),
    down,
    distance,
    yardsToEndzone
  })
  const gained = Play.gainsYards(play) ? play : { team: play.start.team, yards: 0 }

  return encodeEntity({
    id: play.id,
    sequenceNumber: play.sequence,
    type: EspnPlay.typeOf(play),
    text: play.text,
    period: { number: play.period },
    clock: { displayValue: play.clock },
    team: ref(gained.team),
    statYardage: gained.yards,
    scoringPlay: play.scoring,
    homeScore: play.homeScore,
    awayScore: play.awayScore,
    start: spot(play.start),
    end: spot(play.end)
  })
}

/** A game topic's message that adds `entity` to its plays, sent at `at`. */
function message(
  topic: string,
  mid: number,
  at: DateTime.Utc,
  entity: typeof EspnPlay.Entity.Encoded
): FeedFrame {
  const ts = DateTime.toEpochMillis(at)
  return new FeedFrame({
    receivedAt: at,
    sentAt: at,
    sourceId: mid,
    feed: "fastcast",
    channel: topic,
    kind: "message",
    body: JSON.stringify({
      op: "P",
      tc: topic,
      mid,
      pl: JSON.stringify({ ts, pl: [{ op: "add", path: `/entities/plays/${entity.id}`, value: entity }] })
    })
  })
}

/** ESPN's own id of a team: the domain's id without its league. */
function espnId(team: TeamId): string {
  return team.slice(team.indexOf(":") + 1)
}
