const coordinator = globalThis.__LOTUS_SIGNIN_COORDINATOR__ ||= {
  active: 0,
  waiters: [],
  pending: 0,
  nonSigninActive: 0,
  signinWaiters: [],
}

coordinator.pending ||= 0
coordinator.nonSigninActive ||= 0
coordinator.signinWaiters ||= []

export async function beginLotusSignin () {
  coordinator.pending += 1
  while (coordinator.nonSigninActive > 0) {
    await new Promise(resolve => coordinator.signinWaiters.push(resolve))
  }
  coordinator.pending = Math.max(0, coordinator.pending - 1)
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

coordinator.waitForSignin = async function waitForSignin () {
  while (coordinator.active > 0 || coordinator.pending > 0) {
    await new Promise(resolve => coordinator.waiters.push(resolve))
  }
}

coordinator.runNonSigninTask = runLotusNonSigninTask

export async function runLotusNonSigninTask (task) {
  if (typeof task !== "function") throw new TypeError("non-signin task must be a function")
  while (coordinator.active > 0 || coordinator.pending > 0) {
    await new Promise(resolve => coordinator.waiters.push(resolve))
  }
  coordinator.nonSigninActive += 1
  try {
    return await task()
  } finally {
    coordinator.nonSigninActive = Math.max(0, coordinator.nonSigninActive - 1)
    if (coordinator.nonSigninActive === 0) {
      const waiters = coordinator.signinWaiters.splice(0)
      for (const resolve of waiters) resolve()
    }
  }
}
