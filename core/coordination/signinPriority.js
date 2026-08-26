const coordinator = globalThis.__LOTUS_SIGNIN_COORDINATOR__ ||= {
  active: 0,
  waiters: []
}

export function beginLotusSignin () {
  coordinator.active += 1
  let released = false
  return () => {
    if (released) return
    released = true
    coordinator.active = Math.max(0, coordinator.active - 1)
    if (coordinator.active === 0) {
      const waiters = coordinator.waiters.splice(0)
      for (const resolve of waiters) resolve()
    }
  }
}

coordinator.waitForSignin ||= async function waitForSignin () {
  if (coordinator.active === 0) return
  await new Promise(resolve => coordinator.waiters.push(resolve))
}
