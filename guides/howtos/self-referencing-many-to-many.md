---

title: Self-referencing many to many
group: How-To's
---

# Self-referencing many to many

{@link ekto!manyToMany | manyToMany} is used to establish the association between two schemas
with a join table (or a join schema) tracking the relationship between them. But, what if we want
the same table to reference itself? This is commonly used for symmetric relationships and is often
referred to as a self-referencing `manyToMany` association. This guide follows Ecto's
[Self-referencing many to many](https://hexdocs.pm/ecto/self-referencing-many-to-many.html).

## People relationships

Let's imagine we are building a system that supports a model for relationships between people.

```ts
// src/accounts/person.ts
import { manyToMany, schema, t } from "ekto";
import { Relationship } from "../relationships/relationship.ts";

export class Person extends schema("people", {
  id: t.id(),
  name: t.string(),
  ...t.timestamps(),
}) {
  static associations = {
    relationships: manyToMany(() => Person, {
      joinThrough: Relationship,
      joinKeys: { person_id: "id", relation_id: "id" },
    }),
    reverse_relationships: manyToMany(() => Person, {
      joinThrough: Relationship,
      joinKeys: { relation_id: "id", person_id: "id" },
    }),
  };
}
```

```ts
// src/relationships/relationship.ts
import { type Infer, schema, t } from "ekto";

export const Relationship = schema("relationships", {
  id: t.id(),
  person_id: t.integer(),
  relation_id: t.integer(),
  ...t.timestamps(),
});
export type Relationship = Infer<typeof Relationship>;
```

In our example, we implement an intermediate schema, `Relationship`, on our `joinThrough` option
and pass in a pair of ids that we will be creating a unique index on in our database migration. By
implementing an intermediate schema, we make it easy to add additional attributes and
functionality to relationships in the future.

We had to create an additional `manyToMany` `reverse_relationships` association with an inverse
of the `joinKeys` in order to finish the other half of the association. This way, both people in a
relationship see it: one on the `relationships` side, the other on the `reverse_relationships`
side.

The person who is the inverse of the relationship will have the related person stored in a list
under the `reverse_relationships` key. We can then load both `relationships` and
`reverse_relationships` with `repo.preload`:

```ts
const people = await repo.preload(await repo.all(Person), [
  "relationships",
  "reverse_relationships",
]);
// [
//   {
//     id: 1,
//     name: "Ann",
//     ...
//     relationships: [{ id: 2, name: "Bob", ... }],
//     reverse_relationships: []
//   },
//   {
//     id: 2,
//     name: "Bob",
//     ...
//     relationships: [],
//     reverse_relationships: [{ id: 1, name: "Ann", ... }]
//   }
// ]
```

In the example query above, we are assuming that we have two people that have entered into a
relationship. Our query illustrates how one person is added on the `relationships` side and the
other on the `reverse_relationships` side.

It is also worth noticing that we are implementing separate folders for both our `Person` and
`Relationship` schemas. This separation of concerns helps improve code organization and
maintainability by allowing us to isolate core functions for relationships in the
`relationships` folder and vice-versa.

Let's take a look at our migration:

```ts
import {
  index,
  migration,
  references,
  table,
  uniqueIndex,
} from "ekto/migrate";

export default migration({
  change(m) {
    m.create(table("relationships"), (t) => {
      t.add("id", "bigserial", { primaryKey: true });
      t.add("person_id", references("people"), { null: false });
      t.add("relation_id", references("people"), { null: false });
      t.timestamps();
    });

    m.create(index("relationships", ["person_id"]));
    m.create(index("relationships", ["relation_id"]));

    m.create(
      uniqueIndex("relationships", ["person_id", "relation_id"], {
        name: "relationships_person_id_relation_id_index",
      }),
    );
  },
});
```

We create indexes on both the `person_id` and `relation_id` for quicker access in the future.
Then, we create one unique index on the `relationships` to ensure that people cannot have
duplicate relationships. Lastly, we pass a name to the `name` option to help clarify the unique
constraint when working with our changeset.

```ts
// In src/relationships/relationship.ts
import {
  type Changeset,
  cast,
  type New,
  pipe,
  uniqueConstraint,
} from "ekto";

export function changeset<
  D extends Relationship | New<typeof Relationship>,
>(relationship: D | Changeset<D>, params: unknown = {}): Changeset<D> {
  return pipe(
    cast(relationship, params, ["person_id", "relation_id"]),
    uniqueConstraint(["person_id", "relation_id"], {
      name: "relationships_person_id_relation_id_index",
    }),
  );
}
```

Due to the self-referential nature, we will only need to cast the join keys in order to associate
the two records in the database: inserting a relationship is inserting a `Relationship`.

```ts
await repo.insert(
  changeset(Relationship.new(), {
    person_id: ann.id,
    relation_id: bob.id,
  }),
);
```

When considering production applications, we will most likely want to add additional attributes
and validations. This is where our isolation of modules will help us maintain and organize the
increasing complexity.

## Summary

In this guide we used `manyToMany` associations to implement a self-referencing symmetric
relationship.

Our goal was to allow people to associate to different people. Further, we wanted to lay a strong
foundation for code organization and maintainability into the future. We have done this by
creating an intermediate table, two separate modules, a clear naming strategy, an inverse
association, and by using `manyToMany` `joinKeys` to load the people on both sides of the join
table.

Overall, our code contains a small structural modification, when compared with a typical
`manyToMany`, in order to implement an inverse join between our self-referenced table and schema.

Where we go from here will depend greatly on the specific needs of our application. If we remember
to adhere to our clear naming strategy with a strong separation of concerns, we will go a long way
in keeping our self-referencing `manyToMany` association organized and easier to maintain.
