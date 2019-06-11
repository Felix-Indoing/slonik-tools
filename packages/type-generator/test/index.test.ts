import {setupSlonikTs} from '../src'
import {knownTypes} from './db'
import {createPool, QueryResultType} from 'slonik'
import {statSync, readdirSync, existsSync} from 'fs'
import {join} from 'path'
import {tmpdir} from 'os'
import {expectType} from 'ts-expect'

describe('type generator', () => {
  const writeTypes = join(__dirname, 'db')
  const {sql, interceptor} = setupSlonikTs({
    reset: true,
    knownTypes,
    writeTypes,
  })
  const connectionString = `postgresql://postgres:postgres@localhost:5432/postgres`
  const slonik = createPool(connectionString, {
    idleTimeout: 1,
    interceptors: [interceptor],
  })

  beforeAll(async () => {
    await slonik.query(sql`drop table if exists foo`)
    await slonik.query(sql`
      create table foo(
        id serial primary key,
        a text,
        b boolean,
        c text[],
        d timestamptz,
        e circle -- 'circle' maps to 'unknown' for now
      )
    `)
    await slonik.query(sql`insert into foo(a) values('xyz')`)
  })

  // https://github.com/gajus/slonik/issues/63#issuecomment-500889445
  afterAll(() => new Promise(r => setTimeout(r, 0)))

  it('queries', async () => {
    const fooResult = await slonik.one(sql.Foo`select * from foo`)
    expectType<{
      id: number
      a: string
      b: boolean
      c: string[]
      d: number
      e: unknown
    }>(fooResult)
    await slonik.query(sql.Foo`select * from foo`) // make sure duplicate doesn't create two types.
    await slonik.query(sql.CountInfo`
      select count(*) as a_count, a as a_value
      from foo
      group by a
    `)
    const generatedFiles = readdirSync(writeTypes)
    generatedFiles.forEach(f => {
      expect(statSync(join(writeTypes, f)).mtimeMs).toBeGreaterThan(Date.now() - 2000)
    })
    expect(generatedFiles).toMatchInlineSnapshot(`
            Array [
              "CountInfo.ts",
              "Foo.ts",
              "index.ts",
            ]
        `)
  })

  it('creates a pessimistic union type when there are multiple queries', async () => {
    const foo1 = await slonik.one(sql.FooSubset`select a, b, c from foo`)
    const foo2 = await slonik.one(sql.FooSubset`select a, b from foo`)
    expectType<{a: string; b: boolean}>(foo1)
    expectType<{a: string; b: boolean}>(foo2)
    expect(foo1).toMatchObject(foo2)
  })

  it('can customise the default type', async () => {
    type DefaultType = {abc: string}
    const {sql, interceptor} = setupSlonikTs({knownTypes: {defaultType: {} as DefaultType}})
    const slonik = createPool(connectionString, {
      idleTimeout: 1,
      interceptors: [interceptor],
    })
    const foo = await slonik.one(sql.FooBar`select * from foo`)
    expectType<{abc: string}>(foo)
    expect(foo).toMatchInlineSnapshot(`
      Object {
        "a": "xyz",
        "b": null,
        "c": null,
        "d": null,
        "e": null,
        "id": 1,
      }
    `)
  })

  it('can create a prod version', () => {
    expect(Object.keys(setupSlonikTs({knownTypes}))).toMatchInlineSnapshot(`
            Array [
              "interceptor",
              "sql",
            ]
        `)
  })

  it('can create generated types directory', async () => {
    const tempDir = join(tmpdir(), 'test')
    const {sql, interceptor} = setupSlonikTs({reset: true, knownTypes: {}, writeTypes: tempDir})
    expect(existsSync(tempDir)).toBe(true)
    expect(readdirSync(tempDir)).toEqual(['index.ts'])

    const slonik = createPool(connectionString, {
      interceptors: [interceptor],
      idleTimeout: 1,
    })
    await slonik.query(sql.Id`select id from foo`)

    expect(readdirSync(tempDir).sort()).toEqual(['index.ts', 'Id.ts'].sort())
  })

  it('allows custom type mappings', async () => {
    const {sql, interceptor} = setupSlonikTs({
      reset: true,
      knownTypes: await import('./generated/with-date').then(x => x.knownTypes),
      writeTypes: join(__dirname, 'generated', 'with-date'),
      typeMapper: (id, types) => (id === types.timestamptz ? 'Date' : undefined),
    })

    const slonik = createPool(connectionString, {
      idleTimeout: 1,
      interceptors: [interceptor],
      typeParsers: [{
        name: 'timestamptz',
        parse: value => new Date(value),
      }],
    })

    await slonik.query(sql`insert into foo(d) values(now())`)
    const result = await slonik.one(sql.FooWithDate`select d from foo where d is not null`)
    expectType<{d: Date}>(result)
    expect(result).toMatchObject({d: expect.any(Date)})
  })
})