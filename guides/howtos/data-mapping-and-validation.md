---

title: Data mapping and validation
group: How-To's
---

# Data mapping and validation

We will take a look at the role schemas play when validating and casting data through changesets.
As we will see, sometimes the best solution is not to completely avoid schemas, but break a large
schema into smaller ones. Maybe one for reading data, another for writing. Maybe one for your
database, another for your forms. This guide follows Ecto's
[Data mapping and validation](https://hexdocs.pm/ecto/data-mapping-and-validation.html).

## Schemas are mappers

A schema maps a data source to records with typed fields. It is a common misconception to think
schemas map only to your database tables.

For instance, when you write a web application and use ekto to receive external changes and apply
such changes to your database, we have this mapping:

    Database <-> ekto schema <-> Forms / API

Although there is a single schema mapping to both your database and your API, in many situations
it is better to break this mapping in two. Let's see some practical examples.

Imagine you are working with a client that wants the "Sign Up" form to contain the fields "First
name", "Last name" alongside "E-mail" and other information. You know there are a couple problems
with this approach.

First of all, not everyone has a first and last name. Although your client is decided on
presenting both fields, they are a UI concern, and you don't want the UI to dictate the shape of
your data. Furthermore, you know it would be useful to break the "Sign Up" information across two
tables, the `accounts` and `profiles` tables.

Given the requirements above, how would we implement the Sign Up feature in the backend?

One approach would be to have two schemas, `Account` and `Profile`, with virtual fields such as
`first_name` and `last_name`. One of such schemas would be:

```ts
export const Profile = schema("profiles", {
  id: t.id(),
  name: t.string(),
  first_name: t.string({ virtual: true }),
  last_name: t.string({ virtual: true }),
  // ...
});
```

It is not hard to see how we are polluting our `Profile` schema with UI requirements by adding
fields such as `first_name` and `last_name`. If the `Profile` schema is used for both reading and
writing data, it may end up in an awkward place where it is not useful for any, as it contains
fields that map just to one or the other operation.

One alternative solution is to break the "Database <-> ekto schema <-> Forms / API" mapping in
two parts. The first will cast and validate the external data with its own structure which you
then transform and write to the database. For such, let's define the types of a registration,
that will take care of casting and validating the form data exclusively, mapping directly to the
UI fields:

```ts
import { t } from "ekto";

const registration = {
  first_name: t.string(),
  last_name: t.string(),
  email: t.string(),
};
```

These are not a schema of a table, as it is not our intent to persist them anywhere.
{@link ekto!schemaless | schemaless} builds a changeset over plain data with these types, so we
can use changesets and validations to process the data:

```ts
import {
  cast,
  pipe,
  schemaless,
  validateFormat,
  validateLength,
  validateRequired,
} from "ekto";

function changeset(params: unknown) {
  return pipe(
    cast(schemaless(registration), params, [
      "first_name",
      "last_name",
      "email",
    ]),
    validateRequired(["first_name", "last_name", "email"]),
    validateLength("first_name", { max: 100 }),
    validateFormat("email", /@/),
  );
}
```

Now that the registration changes are mapped and validated, we can check if the resulting
changeset is valid and act accordingly. {@link ekto!applyAction | applyAction} returns the data
with the changes applied when the changeset is valid, and the changeset with its action set (so
the UI shows its errors) when it is not:

```ts
import { applyAction } from "ekto";

export async function signUp(params: unknown) {
  const result = applyAction(changeset(params), "insert");
  if (!result.ok) return result; // { ok: false, changeset }

  const registration = result.value;
  await repo.transact(async (tx) => {
    await tx.insertAll(Account, [toAccount(registration)]);
    await tx.insertAll(Profile, [toProfile(registration)]);
    return { ok: true };
  });
  return { ok: true, value: registration } as const;
}
```

The `toAccount` and `toProfile` functions would receive the registration data and split the
attributes apart accordingly:

```ts
type Registration = ReturnType<typeof changeset>["data"];

// validateRequired made sure these are not null
function toAccount({ email }: Registration) {
  return { email: email! };
}

function toProfile({ first_name, last_name }: Registration) {
  return { name: `${first_name} ${last_name}` };
}
```

In the example above, by breaking apart the mapping between the database and TypeScript and
between TypeScript and the UI, our code becomes clearer and our data structures simpler.

Note we have used `repo.insertAll` to add data to both `accounts` and `profiles` tables directly,
without changesets. However, there is nothing stopping you from building `Account.new()` and
`Profile.new()` records in `toAccount` and `toProfile` instead. Once records are returned, they
could be inserted through the usual `repo.insert` operation. One can also check for uniqueness or
other constraints during insertion by wrapping the records in a changeset.

## Schemaless changesets

The registration above used `schemaless` with the field builders of a schema (`t.string()`). It
also takes ekto's types directly, from {@link ekto!types | types}, and the data to start from:

```ts
import { cast, pipe, schemaless, types, validateRequired } from "ekto";

const search = pipe(
  cast(
    schemaless(
      { query: types.string, page: types.integer },
      { page: 1 },
    ),
    params,
    ["query", "page"],
  ),
  validateRequired(["query"]),
);
```

You can use this technique to validate API endpoints, search forms, and other sources of data.
The choice of using schemas depends mostly on whether you want to use the same mapping in
different places or if you desire the record types and loading a schema gives you. Otherwise, you can bypass
schemas altogether, be it when using changesets or interacting with the repository.

However, the most important lesson in this guide is not when to use or not to use schemas, but
rather understand when a big problem can be broken into smaller problems that can be solved
independently leading to an overall cleaner solution. The choice of using schemas or not above
didn't affect the solution as much as the choice of breaking the registration problem apart.
