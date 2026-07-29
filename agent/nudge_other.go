//go:build !linux

package main

// На Windows и macOS источник кадров не зависит от изменений на экране: ddagrab/gdigrab и
// avfoundation выдают кадры с заданной частотой даже на неподвижной картинке. Поэтому
// «шевелить» экран для проверки там не нужно, и мы этого не делаем.
func nudgeSoon(_ <-chan struct{}) {}
