//go:build linux || darwin

package main

import "syscall"

func detachedProcessAttrs() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }