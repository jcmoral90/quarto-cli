

-- append values to table
function tappend(t, values)
  for i,value in pairs(values) do
    table.insert(t, value)
  end
end

-- prepend values to table
function tprepend(t, values)
  for i=1, #values do
   table.insert(t, 1, values[#values + 1 - i])
  end
end

-- does the table contain a value
function tcontains(t,value)
  if t and type(t)=="table" and value then
    for _, v in ipairs (t) do
      if v == value then
        return true
      end
    end
    return false
  end
  return false
end

-- clear a table
function tclear(t)
  for k,v in pairs(t) do
    t[k] = nil
  end
end

-- sorted pairs. order function takes (t, a,)
function spairs(t, order)
  -- collect the keys
  local keys = {}
  for k in pairs(t) do keys[#keys+1] = k end

  -- if order function given, sort by it by passing the table and keys a, b,
  -- otherwise just sort the keys
  if order then
      table.sort(keys, function(a,b) return order(t, a, b) end)
  else
      table.sort(keys)
  end

  -- return the iterator function
  local i = 0
  return function()
      i = i + 1
      if keys[i] then
          return keys[i], t[keys[i]]
      end
  end
end

-- dump an object to stdout
function dump(o)
  if type(o) == 'table' then
    tdump(o)
  else
    print(tostring(o) .. "\n")
  end
end

-- improved formatting for dumping tables
function tdump (tbl, indent)
  if not indent then indent = 0 end
  for k, v in pairs(tbl) do
    formatting = string.rep("  ", indent) .. k .. ": "
    if type(v) == "table" then
      print(formatting)
      tdump(v, indent+1)
    elseif type(v) == 'boolean' then
      print(formatting .. tostring(v))
    else
      print(formatting .. v)
    end
  end
end


