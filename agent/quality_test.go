package main

import (
	"testing"
	"time"
)

// Правило подстройки ошибается тихо: качели между ступенями или залипание на нижней заметны
// только на живом канале и только через некоторое время. Поэтому проверяем его здесь.
func TestGovernorStepsDownFast(t *testing.T) {
	g := &qualityGovernor{}
	now := time.Now()

	// Клиент не успевает: очередь декодера растёт.
	for i := 0; i < 30; i++ {
		g.note()
	}
	tier, changed := g.decide(clientStats{RxFrames: 30, DecodeQueue: 5, WindowMs: 1000}, now)
	if !changed || tier.fps == 0 {
		t.Fatalf("при переполненной очереди ступень не понизилась: %+v", tier)
	}

	// Кадры теряются по дороге — тоже повод сбавить.
	g2 := &qualityGovernor{}
	for i := 0; i < 100; i++ {
		g2.note()
	}
	if _, changed := g2.decide(clientStats{RxFrames: 50, DecodeQueue: 0, WindowMs: 1000}, now); !changed {
		t.Error("дошла половина кадров, а ступень не понизилась")
	}
}

func TestGovernorRaisesOnlyAfterCalm(t *testing.T) {
	g := &qualityGovernor{tier: 2}
	now := time.Now()

	// Первое спокойное окно только запускает отсчёт — поднимать сразу нельзя, иначе получатся
	// качели между ступенями.
	if _, changed := g.decide(clientStats{RxFrames: 30, DecodeQueue: 0}, now); changed {
		t.Error("ступень поднялась после первого же спокойного окна")
	}
	// Через пару секунд — всё ещё рано.
	if _, changed := g.decide(clientStats{RxFrames: 30, DecodeQueue: 0}, now.Add(2*time.Second)); changed {
		t.Error("ступень поднялась раньше положенного спокойствия")
	}
	// А после выдержки — можно.
	if _, changed := g.decide(clientStats{RxFrames: 30, DecodeQueue: 0}, now.Add(calmBeforeRaise+time.Second)); !changed {
		t.Error("после долгого спокойствия ступень так и не поднялась")
	}
	if g.tier != 1 {
		t.Errorf("поднялись не на одну ступень, а на %d", 2-g.tier)
	}
}

func TestGovernorDoesNotFallBelowLadder(t *testing.T) {
	g := &qualityGovernor{tier: len(qualityLadder) - 1}
	now := time.Now()
	for i := 0; i < 5; i++ {
		g.note()
		if _, _ = g.decide(clientStats{RxFrames: 0, DecodeQueue: 99}, now); g.tier > len(qualityLadder)-1 {
			t.Fatal("ступень ушла за пределы лестницы")
		}
	}
	if tier, _ := g.decide(clientStats{RxFrames: 0, DecodeQueue: 99}, now); tier.fps != qualityLadder[len(qualityLadder)-1].fps {
		t.Error("на дне лестницы вернулась не нижняя ступень")
	}
}

func TestGovernorIgnoresEmptyWindow(t *testing.T) {
	// Окно без единого отправленного кадра (спокойный экран) не должно выглядеть как потеря:
	// иначе неподвижный рабочий стол сам себя загонит на нижнюю ступень.
	g := &qualityGovernor{}
	if _, changed := g.decide(clientStats{RxFrames: 0, DecodeQueue: 0}, time.Now()); changed {
		t.Error("пустое окно понизило ступень — неподвижный экран не повод сбавлять")
	}
}

func TestLadderIsMonotonic(t *testing.T) {
	// Лестница должна идти строго вниз по обоим показателям, иначе «понизить» перестаёт
	// означать «нагрузить канал меньше».
	for i := 1; i < len(qualityLadder); i++ {
		prev, cur := qualityLadder[i-1], qualityLadder[i]
		if cur.kbps > prev.kbps {
			t.Errorf("ступень %d требует больше канала, чем предыдущая: %d > %d", i, cur.kbps, prev.kbps)
		}
		// Ноль — «не ограничивать», он допустим только на самом верху.
		if cur.fps == 0 && i != 0 {
			t.Errorf("ступень %d снимает ограничение частоты — это возможно только на верхней", i)
		}
		if prev.fps != 0 && cur.fps > prev.fps {
			t.Errorf("ступень %d просит больше кадров, чем предыдущая: %d > %d", i, cur.fps, prev.fps)
		}
	}
}

func TestGovernorReactsToNetworkLoss(t *testing.T) {
	// Потери в сети видны только клиенту — по разрывам нумерации. Даже если очередь декодера
	// пуста и доля дошедших выглядит приемлемо, потери означают, что канал не тянет.
	g := &qualityGovernor{}
	for i := 0; i < 30; i++ {
		g.note()
	}
	if _, changed := g.decide(clientStats{RxFrames: 29, DecodeQueue: 0, Lost: 12}, time.Now()); !changed {
		t.Error("двенадцать потерянных кадров за окно не понизили ступень")
	}

	// А одиночный пропуск — не повод: он случается и в норме.
	g2 := &qualityGovernor{}
	for i := 0; i < 30; i++ {
		g2.note()
	}
	if _, changed := g2.decide(clientStats{RxFrames: 30, DecodeQueue: 0, Lost: 1}, time.Now()); changed {
		t.Error("одиночный пропуск понизил ступень — так мы будем сбавлять на ровном месте")
	}
}
